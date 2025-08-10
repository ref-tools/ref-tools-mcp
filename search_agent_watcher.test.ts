import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SearchAgent from './search_agent'
import { pickChunksFilter } from './pickdocs'

function tmpDir(prefix = 'search-agent-watch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function eventually(
  assertFn: () => Promise<void> | void,
  timeoutMs = 1000,
  intervalMs = 100,
) {
  const start = Date.now()
  let lastErr: any
  while (Date.now() - start < timeoutMs) {
    try {
      await assertFn()
      return
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  throw lastErr || new Error('condition not met in time')
}

describe('SearchAgent watcher add/remove', () => {
  it('indexes newly added files and makes them searchable', { timeout: 10000 }, async () => {
    const dir = tmpDir()
    // initial repo with one file
    const f1 = path.join(dir, 'a.ts')
    fs.writeFileSync(f1, `export function alpha(){ return 1 } // alpha\n`)

    const agent = new SearchAgent(dir, {
      languages: ['typescript'],
      watch: true,
      pollIntervalMs: 100,
      relevanceFilter: pickChunksFilter,
    })
    await agent.ingest()

    // baseline: search for beta should not include b.ts yet
    let res = await agent.search_query('beta')
    expect(res.some((c) => /b\.ts$/.test(c.filePath))).toBe(false)

    // add new file with beta symbol
    const f2 = path.join(dir, 'b.ts')
    fs.writeFileSync(f2, `export const beta = () => 2 // beta\n`)

    await new Promise((r) => setTimeout(r, 300))

    // wait until search returns beta
    await eventually(async () => {
      const out = await agent.search_query('beta')
      expect(out.some((c) => /b\.ts$/.test(c.filePath))).toBe(true)
    })
  })

  it(
    'removes deleted files from the index so they no longer appear in search',
    { timeout: 10000 },
    async () => {
      const dir = tmpDir()
      const f1 = path.join(dir, 'keep.ts')
      const f2 = path.join(dir, 'drop.ts')
      fs.writeFileSync(f1, `export const alpha = 1 // alpha\n`)
      fs.writeFileSync(f2, `export const beta = 2 // beta\n`)

      const agent = new SearchAgent(dir, {
        languages: ['typescript'],
        watch: true,
        pollIntervalMs: 100,
        relevanceFilter: pickChunksFilter,
      })
      await agent.ingest()

      // ensure beta is findable first
      await eventually(async () => {
        const out = await agent.search_query('beta')
        expect(out.some((c) => /drop\.ts$/.test(c.filePath))).toBe(true)
      })

      // delete the file containing beta
      fs.unlinkSync(f2)
      await new Promise((r) => setTimeout(r, 300))

      // wait until beta no longer appears in results
      await eventually(async () => {
        const out = await agent.search_query('beta')
        expect(out.some((c) => /drop\.ts$/.test(c.filePath))).toBe(false)
        agent.stopWatcher()
      })
    },
  )
})
