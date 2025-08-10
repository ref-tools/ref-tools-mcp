import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { REPOS, selectRepos } from './cli_bench'

const ORIGINAL_ENV = { ...process.env }

describe('selectRepos', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env.BENCH_MODE
    delete process.env.BENCH_REPOS
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('returns all repos by default', () => {
    const repos = selectRepos()
    expect(repos.map((r) => r.name)).toEqual(REPOS.map((r) => r.name))
  })

  it("returns only 'chalk' in small mode via arg", () => {
    const repos = selectRepos('small')
    expect(repos).toHaveLength(1)
    expect(repos[0]!.name).toBe('chalk')
  })

  it("returns only 'chalk' in small mode via BENCH_MODE env", () => {
    process.env.BENCH_MODE = 'small'
    const repos = selectRepos()
    expect(repos).toHaveLength(1)
    expect(repos[0]!.name).toBe('chalk')
  })

  it('filters by BENCH_REPOS list when provided', () => {
    process.env.BENCH_REPOS = 'chalk, axios'
    const repos = selectRepos()
    expect(repos.map((r) => r.name).sort()).toEqual(['axios', 'chalk'])
  })

  it('viewer HTML includes checkbox container for runs', () => {
    // Import the module file source to assert the embedded HTML contains our runs container
    // We read the file directly to avoid executing it
    const fs = require('fs') as typeof import('fs')
    const src = fs.readFileSync(require('path').join(__dirname, 'cli_bench.ts'), 'utf8')
    expect(src).toContain('<div id="runs" class="runs" role="group" aria-label="Runs"></div>')
    expect(src).toContain("input.type = 'checkbox'")
  })
})
