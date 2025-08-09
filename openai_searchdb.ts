import path from 'node:path'
import type { Chunk } from './chunker'
import type { Embedder, Labeler } from './searchdb'

export type OpenAILabelerOptions = {
  apiKey: string
  model?: string // e.g., 'gpt5-nano'
}

export type OpenAIEmbedderOptions = {
  apiKey: string
  model?: string // e.g., 'text-embedding-3-small'
}

export function makeOpenAILabeler(opts: OpenAILabelerOptions): Labeler {
  const apiKey = opts.apiKey
  const model = opts.model || 'gpt5-nano'
  return async (chunk: Chunk): Promise<string> => {
    const prompt =
      `Briefly (<30 words) label this code, including key function names if present.\n` +
      `File: ${path.basename(chunk.filePath)}\n` +
      `Lines: ${chunk.line}-${chunk.endLine}\n` +
      `Content:\n${chunk.content}`
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: prompt }),
    })
    if (!res.ok) throw new Error(`OpenAI label error: ${res.status} ${await res.text()}`)
    const data: any = await res.json()
    const text: string = data.output_text || data.content?.[0]?.text || data.choices?.[0]?.message?.content || ''
    return text.trim().split(/\s+/).slice(0, 30).join(' ')
  }
}

export function makeOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const apiKey = opts.apiKey
  const model = opts.model || 'text-embedding-3-small'
  return async (text: string): Promise<number[]> => {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
    })
    if (!res.ok) throw new Error(`OpenAI embed error: ${res.status} ${await res.text()}`)
    const data: any = await res.json()
    const vec: number[] = data.data?.[0]?.embedding
    if (!Array.isArray(vec)) throw new Error('Invalid embedding response')
    return vec
  }
}

