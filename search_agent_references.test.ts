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

    const rows = agent.search_graph(
      "MATCH (u:Chunk { name: 'beta' })-[:REFERENCES]->(d:Chunk { name: 'alpha' }) RETURN count(*) AS count",
    )
    expect(rows[0]?.count || 0).toBeGreaterThan(0)
  })
})
