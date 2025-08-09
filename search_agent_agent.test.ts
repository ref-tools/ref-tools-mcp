import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// import crypto from 'node:crypto'
import SearchAgent, { runAgentWithStreaming, type AgentStreamEvent } from './search_agent'

function tmpDir(prefix = 'search-agent-ai-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// no-op helper retained intentionally for structure; not used

describe('SearchAgent LLM agent fallback streaming', () => {
  it('streams tool calls and returns markdown without OpenAI key (answer mode)', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'alpha.ts')
    fs.writeFileSync(file, `export function alpha(){ return 'ok' } // alpha feature\n`)

    const agent = new SearchAgent(dir, { languages: ['typescript'] })
    await agent.ingest()

    const events: AgentStreamEvent[] = []
    const res = await runAgentWithStreaming(agent, 'alpha feature', (e) => events.push(e), 'answer')

    // Should have emitted a tool call + result and a final markdown
    const hasCall = events.some((e) => e.type === 'tool_call' && e.name === 'search_query')
    const hasResult = events.some((e) => e.type === 'tool_result' && e.name === 'search_query')
    const final = events.find((e) => e.type === 'final') as any
    expect(hasCall && hasResult && !!final).toBe(true)
    expect(typeof res.markdown).toBe('string')
    expect(res.markdown.toLowerCase()).toContain('alpha')
  })

  it('findContext mode selects chunks and emits finalize step without OpenAI key', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), `export const alpha = 1 // alpha\n`)
    fs.writeFileSync(path.join(dir, 'b.ts'), `export const beta = 2 // beta\n`)

    const agent = new SearchAgent(dir, { languages: ['typescript'] })
    await agent.ingest()

    const events: AgentStreamEvent[] = []
    const res = await runAgentWithStreaming(agent, 'alpha', (e) => events.push(e), 'findContext')
    const hasFinalize = events.some((e) => e.type === 'tool_call' && e.name === 'finalize_context' && (e as any).input?.finalize)
    expect(hasFinalize).toBe(true)
    expect(res.chunks && res.chunks.length > 0).toBe(true)
    // Markdown should list at least one selected chunk path
    expect(res.markdown).toMatch(/a\.ts|b\.ts/)
  })
})
