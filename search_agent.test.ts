import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SearchAgent from './search_agent'

function tmpDir(prefix = 'search-agent-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('SearchAgent ingest + search', () => {
  it('indexes a small repo and returns search results', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'sample.ts')
    fs.writeFileSync(
      f,
      `export function alpha() { return 1 }\nexport function other() { return 2 }`,
    )

    const agent = new SearchAgent(dir, { languages: ['typescript'] })
    await agent.ingest()
    const res = await agent.search_query('alpha function')
    const names = res.map((c) => c.name || '')
    expect(names.join(' ')).toMatch(/alpha/)
  })
})

describe('SearchAgent graph queries', () => {
  it('returns nodes via cypher MATCH', async () => {
    const dir = tmpDir()
    const f = path.join(dir, 'one.js')
    fs.writeFileSync(f, `function x(){ return 42 }`)
    const agent = new SearchAgent(dir, { languages: ['javascript'] })
    await agent.ingest()
    const rows = agent.search_graph('MATCH (n:Chunk) RETURN count(*) AS c')
    expect(rows[0].c).toBeGreaterThan(0)
  })
})

describe('SearchAgent watcher + merkle tree', () => {
  const dir = tmpDir()
  const f = path.join(dir, 'watch.ts')
  let agent: SearchAgent

  beforeAll(async () => {
    fs.writeFileSync(f, `export function v(){ return 'alpha' }`)
    agent = new SearchAgent(dir, { languages: ['typescript'], watch: true, pollIntervalMs: 150 })
    await agent.ingest()
  })

  afterAll(() => {
    agent.stopWatcher()
  })

  it('updates index when file content changes', async () => {
    const initialRoot = agent.getMerkleRoot()
    fs.writeFileSync(f, `export function v(){ return 'beta' }`)
    // wait a bit for poller
    await new Promise((r) => setTimeout(r, 400))
    const newRoot = agent.getMerkleRoot()
    expect(newRoot).not.toBe(initialRoot)
    const res = await agent.search_query('beta')
    const all = res.map((c) => `${c.filePath}:${c.line}-${c.endLine}`).join('\n')
    expect(all).toContain('watch.ts')
  })
})

