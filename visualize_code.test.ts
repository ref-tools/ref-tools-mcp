import { describe, it, expect, beforeEach } from 'vitest'
import { visualizeCodeTool, callVisualizeCode } from './visualize_code'

describe('visualize_code tool schema', () => {
  it('exposes message in input schema and requires it', () => {
    const schema: any = (visualizeCodeTool as any).inputSchema
    expect(schema?.properties?.message).toBeTruthy()
    expect(schema?.required).toContain('message')
  })
})

describe('callVisualizeCode', () => {
  beforeEach(() => {
    // Ensure OPENAI_API_KEY is not set so we hit the early return path in tests
    delete (process as any).env.OPENAI_API_KEY
  })

  it('returns a text response when OPENAI_API_KEY is missing', async () => {
    const res: any = await callVisualizeCode({ message: 'Show module relationships' })
    expect(Array.isArray(res?.content)).toBe(true)
    expect(res.content[0]?.type).toBe('text')
    expect(String(res.content[0]?.text || '')).toContain('Missing OPENAI_API_KEY')
  })
})
