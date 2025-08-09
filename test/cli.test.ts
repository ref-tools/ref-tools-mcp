import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chunkCodebase } from '../src/chunker'
import { readJsonChunks, writeJsonChunks, toHumanReadable } from '../src/cli'

function tmpDir(prefix = 'chunker-cli-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('CLI helpers JSON mode', () => {
  it('writes and reads JSONL correctly', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'sample.js')
    fs.writeFileSync(
      file,
      `// sample
function add(a, b) { return a + b }
class Box { constructor(v){ this.v = v } }
`,
    )

    const chunks = await chunkCodebase(dir, { languages: ['javascript'] })
    expect(chunks.length).toBeGreaterThan(0)

    const out = path.join(dir, 'chunks.jsonl')
    writeJsonChunks(out, chunks) // default jsonl
    expect(fs.existsSync(out)).toBe(true)

    const back = readJsonChunks(out)
    expect(back.length).toBe(chunks.length)
    // spot-check a couple fields
    expect(back[0]).toHaveProperty('filePath')
    expect(back[0]).toHaveProperty('contentHash')
  })

  it('writes and reads JSON array correctly', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'sample.py')
    fs.writeFileSync(
      file,
      `def hi(x):\n    return x\n\nclass C:\n    pass\n`,
    )

    const chunks = await chunkCodebase(dir, { languages: ['python'] })
    const out = path.join(dir, 'chunks.json')
    writeJsonChunks(out, chunks, { format: 'array', pretty: true })
    const raw = fs.readFileSync(out, 'utf8')
    expect(raw.trim().startsWith('[')).toBe(true)
    const back = readJsonChunks(out)
    expect(back.length).toBe(chunks.length)
  })
})

describe('CLI helpers human mode', () => {
  it('formats human-readable output grouped by file', async () => {
    const dir = tmpDir()
    const fileTs = path.join(dir, 't.ts')
    fs.writeFileSync(fileTs, `export function ping(){ return 'pong' }`)

    const chunks = await chunkCodebase(dir, { languages: ['typescript'] })
    const text = toHumanReadable(chunks, { relativeTo: dir })
    expect(text).toMatch(/File: ./)
    expect(text).toMatch(/\• \[typescript\] /)
    expect(text.split('\n').length).toBeGreaterThan(1)
  })
})

