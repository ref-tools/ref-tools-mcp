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
})
