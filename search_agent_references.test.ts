import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SearchAgent from './search_agent'

function tmpDir(prefix = 'search-agent-refs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('buildCreateCypherForChunks REFERENCES edges', () => {
  it('creates REFERENCES edges from usage chunks to definition chunks by name match', async () => {
    const dir = tmpDir()
    const fa = path.join(dir, 'a.ts')
    const fb = path.join(dir, 'b.ts')
    fs.writeFileSync(fa, `export function alpha(){ return 1 }\n`)
    fs.writeFileSync(
      fb,
      [`export function beta(){`, `  return alpha()`, `}`, `export { beta }`, ``].join('\n'),
    )

    const agent = new SearchAgent(dir, { languages: ['typescript'] })
    await agent.ingest()

    const chunks = agent.search_graph(
      "MATCH (u:Chunk { name: 'beta' })-[:REFERENCES]->(d:Chunk { name: 'alpha' }) RETURN u",
    )
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('does not create spurious REFERENCES when a chunk references its own symbol name present in another file', async () => {
    const dir = tmpDir()
    const fa = path.join(dir, 'a.ts')
    const fb = path.join(dir, 'b.ts')
    // a.ts defines a unique function name 'run'
    fs.writeFileSync(fa, `export function run(){ return 1 }\n`)
    // b.ts defines a class with a method also named 'run' but does not use a.run
    fs.writeFileSync(
      fb,
      [
        `export class GraphDB {`,
        `  run(){`,
        `    // method body that does not reference a.run`,
        `    return 2`,
        `  }`,
        `}`,
        ``,
      ].join('\n'),
    )

    const agent = new SearchAgent(dir, { languages: ['typescript'] })
    await agent.ingest()

    // No REFERENCES should exist from any chunk in b.ts to the 'run' definition in a.ts
    const chunks = agent.search_graph(
      `MATCH (b:Chunk { filePath: '${fb.replace(/\\/g, '\\\\')}' })-[:REFERENCES]->(a:Chunk { name: 'run', filePath: '${fa.replace(
        /\\\\/g,
        '\\\\\\\\',
      )}' }) RETURN b`,
    )
    expect(chunks.length).toBe(0)
  })
})
