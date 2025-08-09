import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { SearchDB, type Embedder, type Labeler, type RelevanceFilter } from './searchdb'
import type { Chunk } from './chunker'

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function mkChunk(id: string, content: string, filePath = `/tmp/${id}.ts`): Chunk {
  return {
    id,
    filePath,
    language: 'typescript',
    type: 'function_declaration',
    name: id,
    line: 1,
    endLine: 1,
    content,
    contentHash: sha256Hex(content),
    relations: [],
  }
}

function tmpCacheFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchdb-'))
  return path.join(dir, 'cache.json')
}

// Simple 2-dim embedder: counts of 'alpha' and 'beta'
const countEmbedder: Embedder = async (text: string) => {
  const lower = text.toLowerCase()
  const a = (lower.match(/\balpha\b/g) || []).length
  const b = (lower.match(/\bbeta\b/g) || []).length
  return [a, b]
}

describe('SearchDB', () => {
  let cachePath: string

  beforeEach(() => {
    cachePath = tmpCacheFile()
  })

  it('caches description and embeddings by contentHash', async () => {
    let labelCalls = 0
    let embedCalls = 0
    const labeler: Labeler = async (chunk) => {
      labelCalls++
      return `Brief label for ${chunk.name} mentioning foo()`
    }
    const embedder: Embedder = async (text) => {
      embedCalls++
      return countEmbedder(text)
    }

    const c = mkChunk('c1', 'alpha content here')
    const db1 = new SearchDB({ labeler, embedder, cachePath })
    await db1.addChunk(c)
    expect(labelCalls).toBe(1)
    expect(embedCalls).toBe(1)
    // Ensure cache file written
    const raw = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed[c.contentHash]).toBeTruthy()
    expect(Array.isArray(parsed[c.contentHash].embedding)).toBe(true)
    expect(typeof parsed[c.contentHash].description).toBe('string')

    // New instance should reuse cache and not call label/embed again
    const db2 = new SearchDB({
      cachePath,
      labeler: async () => {
        throw new Error('labeler should not be called for cached item')
      },
      embedder: async () => {
        throw new Error('embedder should not be called for cached item')
      },
    })
    await db2.addChunk(c)
  })

  it('BM25 returns token-matching chunks', async () => {
    const db = new SearchDB({ cachePath, embedder: countEmbedder, labeler: async () => 'desc' })
    const a = mkChunk('a', 'database connection pool manager')
    const b = mkChunk('b', 'image processing pipeline for photos')
    await db.addChunks([a, b])
    const res = await db.search('connection pool', { bm25K: 2, knnK: 0 })
    const ids = res.map((c) => c.id)
    expect(ids).toContain('a')
  })

  it('KNN returns embedding nearest neighbors', async () => {
    const db = new SearchDB({ cachePath, embedder: countEmbedder, labeler: async () => 'desc' })
    const a = mkChunk('a', 'alpha alpha here')
    const b = mkChunk('b', 'beta beta here')
    await db.addChunks([a, b])
    const res = await db.search('alpha', { bm25K: 0, knnK: 1 })
    expect(res.length).toBe(1)
    expect(res[0]!.id).toBe('a')
  })

  it('hybrid merges bm25 and knn candidates', async () => {
    const db = new SearchDB({ cachePath, embedder: countEmbedder, labeler: async () => 'desc' })
    const bm25Chunk = mkChunk('t', 'unique textonly tokens zyxwv zyxwv zyxwv')
    const knnChunk = mkChunk('k', 'alpha alpha content')
    await db.addChunks([bm25Chunk, knnChunk])
    const res = await db.search('alpha zyxwv textonly', { bm25K: 1, knnK: 1 })
    const ids = res.map((c) => c.id)
    expect(ids).toContain('t')
    expect(ids).toContain('k')
  })

  it('final relevance filter applies to descriptions', async () => {
    const relevanceFilter: RelevanceFilter = async (query, items) => {
      void query
      // Keep only items whose description includes 'alpha'
      const keep = items.filter((i) => /alpha/i.test(i.description)).map((i) => i.id)
      return keep
    }
    const labeler: Labeler = async (chunk) => (chunk.id === 'x' ? 'alpha handler' : 'beta handler')
    const db = new SearchDB({ cachePath, embedder: countEmbedder, labeler, relevanceFilter })
    const x = mkChunk('x', 'something')
    const y = mkChunk('y', 'other')
    await db.addChunks([x, y])
    const res = await db.search('alpha query', { bm25K: 2, knnK: 2 })
    expect(res.map((c) => c.id)).toEqual(['x'])
  })
})
