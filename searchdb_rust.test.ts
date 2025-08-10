import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { RustSearchDB } from './searchdb_rust'
import type { Chunk } from './chunker'
import type { ChunkAnnotator } from './searchdb'

function makeChunk(id: string, content: string): Chunk {
  return {
    id,
    filePath: `/tmp/${id}.ts`,
    language: 'typescript',
    type: 'file',
    name: `${id}.ts`,
    line: 1,
    endLine: content.split('\n').length,
    content,
    contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    relations: [],
  }
}

const stubAnnotator: ChunkAnnotator = {
  async labelAndEmbed(chunk) {
    return {
      description: `desc:${chunk.id}`,
      embedding: new Array(4).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    }
  },
  async embed(_text: string) {
    return [1, 0, 0, 0]
  },
}

describe('RustSearchDB basic', () => {
  it('adds and finds a chunk', async () => {
    const db = new RustSearchDB({ annotator: stubAnnotator })
    const c = makeChunk('a1', 'function hello(){ return 42 } // foo bar baz')
    await db.addChunk(c)
    const res = await db.search('foo')
    expect(res.length).toBeGreaterThan(0)
    expect(res.some((x) => x.id === 'a1')).toBe(true)
  })
})
