import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Parser from 'tree-sitter'
import { chunkFile, chunkCodebase } from './chunker'

function write(dir: string, rel: string, content: string) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

describe('chunker error handling', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chunker-err-'))

  afterEach(() => {
    // restore parse if spied
    try {
      // @ts-expect-error vitest adds mockRestore if it is a spy
      Parser.prototype.parse.mockRestore?.()
    } catch {}
  })

  it('returns file-only chunk when parser throws for a file', async () => {
    const badFile = path.join(tmp, 'bad.js')
    write(tmp, 'bad.js', `// THROW_PARSE\nfunction bad(){ return 1 }`)

    const originalParse = Parser.prototype.parse
    // Spy: throw only for inputs containing marker
    // @ts-expect-error override for test
    vi.spyOn(Parser.prototype as any, 'parse').mockImplementation(function (
      this: Parser,
      input: any,
      ...rest: any[]
    ) {
      if (typeof input === 'string' && input.includes('THROW_PARSE')) {
        throw new Error('Invalid argument')
      }
      // call through
      return (originalParse as any).call(this, input, ...rest)
    })

    const chunks = (await chunkFile(badFile))!
    expect(chunks).toBeTruthy()
    // Only the file chunk should be present
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.type).toBe('file')
    expect(chunks[0]!.filePath).toContain('bad.js')
  })

  it('continues chunking codebase when one file parse fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunker-err-tree-'))
    write(dir, 'good.js', `function ok(){ return 42 }`)
    write(dir, 'bad.js', `/* THROW_PARSE */\nexport function nope() {}`)

    const originalParse = Parser.prototype.parse
    // @ts-expect-error override for test
    vi.spyOn(Parser.prototype as any, 'parse').mockImplementation(function (
      this: Parser,
      input: any,
      ...rest: any[]
    ) {
      if (typeof input === 'string' && input.includes('THROW_PARSE')) {
        throw new Error('Invalid argument')
      }
      return (originalParse as any).call(this, input, ...rest)
    })

    const chunks = await chunkCodebase(dir, { languages: ['javascript'] })
    const fileChunks = chunks.filter((c) => c.type === 'file')
    // two files -> two file chunks should exist
    expect(fileChunks.length).toBe(2)
    // ensure we still captured function from good.js
    const hasOk = chunks.some((c) => c.type === 'function_declaration' && c.name === 'ok')
    expect(hasOk).toBe(true)
  })
})
