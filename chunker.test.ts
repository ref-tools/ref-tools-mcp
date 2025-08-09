import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chunkCodebase, chunkFile, type Chunk } from './chunker'

function write(dir: string, rel: string, content: string) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function findChunk(chunks: Chunk[], predicate: (c: Chunk) => boolean): Chunk {
  const c = chunks.find(predicate)
  if (!c) throw new Error('Expected chunk not found')
  return c
}

describe('chunker by language', () => {
  let tmp: string
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chunker-'))

    // JavaScript
    write(
      tmp,
      'js/example.js',
      `export class Greeter {\n  constructor(name) { this.name = name }\n  greet() { return 'hi ' + this.name }\n}\nexport function topLevel(a, b) { return a + b }\n`,
    )

    // TypeScript
    write(
      tmp,
      'ts/example.ts',
      `export class Calc {\n  add(a: number, b: number) { return a + b }\n}\nexport function mul(a: number, b: number): number { return a * b }\n`,
    )

    // Python
    write(
      tmp,
      'py/example.py',
      `class User:\n    def __init__(self, name):\n        self.name = name\n\n    def hello(self):\n        return 'hi ' + self.name\n\n\ndef util(x, y):\n    return x + y\n`,
    )

    // Go
    write(
      tmp,
      'go/example.go',
      `package main\n\ntype Point struct { X int; Y int }\n\nfunc (p Point) Sum() int { return p.X + p.Y }\n\nfunc Top(a int, b int) int { return a + b }\n`,
    )

    // Java
    write(
      tmp,
      'java/Example.java',
      `public class Example {\n  public int add(int a, int b) { return a + b; }\n}\n`,
    )

    // Ruby
    write(tmp, 'rb/example.rb', `class Foo\n  def bar(x, y)\n    x + y\n  end\nend\n`)

    // C
    write(tmp, 'c/example.c', `#include <stdio.h>\nint add(int a, int b) { return a + b; }\n`)
  })

  it('chunks JavaScript with classes and functions', async () => {
    const file = path.join(tmp, 'js/example.js')
    const chunks = (await chunkFile(file))!
    const cls = findChunk(chunks, (c) => c.type === 'class_declaration' && c.name === 'Greeter')
    const fn = findChunk(chunks, (c) => c.type === 'function_declaration' && c.name === 'topLevel')
    expect(cls.filePath).toContain('example.js')
    expect(cls.line).toBeGreaterThan(0)
    expect(cls.content).toContain('class Greeter')
    expect(fn.content).toContain('function topLevel')
    const fileChunk = findChunk(chunks, (c) => c.type === 'file')
    expect(fileChunk.relations.some((r) => r.type === 'contains' && r.targetId === cls.id)).toBe(
      true,
    )
  })

  it('chunks TypeScript with classes and functions', async () => {
    const file = path.join(tmp, 'ts/example.ts')
    const chunks = (await chunkFile(file))!
    const cls = findChunk(chunks, (c) => c.type === 'class_declaration' && c.name === 'Calc')
    const fn = findChunk(chunks, (c) => c.type === 'function_declaration' && c.name === 'mul')
    expect(cls.content).toContain('class Calc')
    expect(fn.content).toContain('function mul')
  })

  it('chunks Python with classes and functions', async () => {
    const file = path.join(tmp, 'py/example.py')
    const chunks = (await chunkFile(file))!
    const cls = findChunk(chunks, (c) => c.type === 'class_definition' && c.name === 'User')
    const fn = findChunk(chunks, (c) => c.type === 'function_definition' && c.name === 'util')
    expect(cls.content).toContain('class User')
    expect(fn.content).toContain('def util')
  })

  it('chunks Go with methods and functions', async () => {
    const file = path.join(tmp, 'go/example.go')
    const chunks = (await chunkFile(file))!
    const m = findChunk(chunks, (c) => c.type === 'method_declaration' && c.name === 'Sum')
    const f = findChunk(chunks, (c) => c.type === 'function_declaration' && c.name === 'Top')
    expect(m.content).toContain('func (p Point) Sum')
    expect(f.content).toContain('func Top')
  })

  it('chunks Java with classes and methods', async () => {
    const file = path.join(tmp, 'java/Example.java')
    const chunks = (await chunkFile(file))!
    const cls = findChunk(chunks, (c) => c.type === 'class_declaration' && c.name === 'Example')
    const m = findChunk(chunks, (c) => c.type === 'method_declaration' && c.name === 'add')
    expect(cls.content).toContain('class Example')
    expect(m.content).toContain('int add')
  })

  it('chunks Ruby with classes and methods', async () => {
    const file = path.join(tmp, 'rb/example.rb')
    const chunks = (await chunkFile(file))!
    const cls = findChunk(chunks, (c) => c.type === 'class' && c.name === 'Foo')
    const m = findChunk(chunks, (c) => c.type === 'method' && c.name === 'bar')
    expect(cls.content).toContain('class Foo')
    expect(m.content).toContain('def bar')
  })

  it('chunks C with functions', async () => {
    const file = path.join(tmp, 'c/example.c')
    const chunks = (await chunkFile(file))!
    const fn = findChunk(chunks, (c) => c.type === 'function_definition' && c.name === 'add')
    expect(fn.content).toContain('int add')
  })

  it('chunks an entire codebase tree', async () => {
    const chunks = await chunkCodebase(tmp)
    // Should have at least one file chunk per file plus some function/class chunks
    const fileChunks = chunks.filter((c) => c.type === 'file')
    expect(fileChunks.length).toBeGreaterThanOrEqual(7)
    // Ensure relationships exist
    const hasContains = chunks.some((c) => c.relations.some((r) => r.type === 'contains'))
    expect(hasContains).toBe(true)
  })
})
