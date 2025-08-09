import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { SearchDB, type ChunkAnnotator, type RelevanceFilter } from './searchdb'
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

// Simple 2-dim embedder: counts of 'alpha' and 'beta'
const countEmbedder = async (text: string) => {
  const lower = text.toLowerCase()
  const a = (lower.match(/\balpha\b/g) || []).length
  const b = (lower.match(/\bbeta\b/g) || []).length
  return [a, b]
}

const simpleAnnotator: ChunkAnnotator = {
  async labelAndEmbed(chunk) {
    const description = 'desc'
    const embedding = await countEmbedder(`${description}\n\n${chunk.content}`)
    return { description, embedding }
  },
  async embed(text) {
    return countEmbedder(text)
  },
}

describe('SearchDB', () => {
  it('caches description and embeddings by contentHash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchdb-'))
    const cachePath = path.join(dir, 'cache.json')
    let calls = 0
    const makeCachingAnnotator = (file: string): ChunkAnnotator => ({
      async labelAndEmbed(chunk) {
        const key = chunk.contentHash || sha256Hex(chunk.content)
        let map: Record<string, any> = {}
        if (fs.existsSync(file)) {
          map = JSON.parse(fs.readFileSync(file, 'utf8') || '{}')
        }
        if (map[key]) return map[key]
        calls++
        const description = `Brief label for ${chunk.name} mentioning foo()`
        const embedding = await countEmbedder(`${description}\n\n${chunk.content}`)
        map[key] = { description, embedding }
        fs.writeFileSync(file, JSON.stringify(map))
        return map[key]
      },
      async embed(text) {
        return countEmbedder(text)
      },
    })

    const c = mkChunk('c1', 'alpha content here')
    const ann1 = makeCachingAnnotator(cachePath)
    const db1 = new SearchDB({ annotator: ann1 })
    await db1.addChunk(c)
    expect(calls).toBe(1)
    // Ensure cache file written
    const raw = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed[c.contentHash]).toBeTruthy()
    expect(Array.isArray(parsed[c.contentHash].embedding)).toBe(true)
    expect(typeof parsed[c.contentHash].description).toBe('string')

    // New instance should reuse cache and not call label/embed again
    const ann2 = makeCachingAnnotator(cachePath)
    const db2 = new SearchDB({ annotator: ann2 })
    await db2.addChunk(c)
    expect(calls).toBe(1)
  })

  it('BM25 returns token-matching chunks', async () => {
    const db = new SearchDB({ annotator: simpleAnnotator })
    const a = mkChunk('a', 'database connection pool manager')
    const b = mkChunk('b', 'image processing pipeline for photos')
    await db.addChunks([a, b])
    const res = await db.search('connection pool', { bm25K: 2, knnK: 0 })
    const ids = res.map((c) => c.id)
    expect(ids).toContain('a')
  })

  it('KNN returns embedding nearest neighbors', async () => {
    const db = new SearchDB({ annotator: simpleAnnotator })
    const a = mkChunk('a', 'alpha alpha here')
    const b = mkChunk('b', 'beta beta here')
    await db.addChunks([a, b])
    const res = await db.search('alpha', { bm25K: 0, knnK: 1 })
    expect(res.length).toBe(1)
    expect(res[0]!.id).toBe('a')
  })

  it('hybrid merges bm25 and knn candidates', async () => {
    const db = new SearchDB({ annotator: simpleAnnotator })
    const bm25Chunk = mkChunk('t', 'unique textonly tokens zyxwv zyxwv zyxwv')
    const knnChunk = mkChunk('k', 'alpha alpha content')
    await db.addChunks([bm25Chunk, knnChunk])
    const res = await db.search('alpha zyxwv textonly', { bm25K: 1, knnK: 1 })
    const ids = res.map((c) => c.id)
    expect(ids).toContain('t')
    expect(ids).toContain('k')
  })

  it('final relevance filter can refine chunk candidates', async () => {
    const relevanceFilter: RelevanceFilter = async (query, chunks) => {
      void query
      // Keep only items whose content includes 'alpha'
      return chunks.filter((c) => /\balpha\b/i.test(c.content))
    }
    const db = new SearchDB({ annotator: simpleAnnotator, relevanceFilter })
    const x = mkChunk('x', 'alpha something')
    const y = mkChunk('y', 'other')
    await db.addChunks([x, y])
    const res = await db.search('alpha query', { bm25K: 2, knnK: 2 })
    expect(res.map((c) => c.id)).toEqual(['x'])
  })
})
