import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SearchAgent from './search_agent'

function tmpDir(prefix = 'search-agent-text-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('SearchAgent text-item helpers', () => {
  it('searchQueryAsTextItems returns formatted text items', async () => {
    const dir = tmpDir()
    const filePath = path.join(dir, 'sample.ts')
    fs.writeFileSync(
      filePath,
      `export function alpha() { return 1 }\nexport function beta() { return 2 }`,
    )

    const agent = new SearchAgent(dir, { languages: ['typescript'] })
    await agent.ingest()
    const items = await agent.searchQueryAsTextItems('alpha')
    expect(items.length).toBeGreaterThan(0)
    const t = items[0]!.text
    expect(t).toContain('sample.ts')
    expect(t).toContain('---')
    expect(typeof items[0]!.type).toBe('string')
    expect(items[0]!.type).toBe('text')
  })

  it('searchGraphAsTextItems returns formatted text items', async () => {
    const dir = tmpDir()
    const filePath = path.join(dir, 'one.js')
    fs.writeFileSync(filePath, `function x(){ return 42 }`)

    const agent = new SearchAgent(dir, { languages: ['javascript'] })
    await agent.ingest()
    const items = agent.searchGraphAsTextItems('MATCH (n:Chunk) RETURN n LIMIT 5')
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]!.type).toBe('text')
    expect(items[0]!.text).toContain('one.js')
    expect(items[0]!.text).toContain('---')
  })
})
