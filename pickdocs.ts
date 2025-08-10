import path from 'node:path'
import { z } from 'zod'
import type { AnnotatedChunk } from './chunker'

const PickChunksSchema = z.object({
  chunks: z.array(z.number()),
})

export type PickChunksOptions = {
  apiKey: string
  model?: string // defaults to 'gpt-5-nano'
  maxItems?: number // cap number of presented chunks
}

function chunkListToPrompt(chunks: AnnotatedChunk[]): string {
  return chunks
    .map((c, index) => {
      const baseName = path.basename(c.filePath)
      const name = c.name ? ` ${c.name}` : ''
      const loc = `${c.line}-${c.endLine}`
      return `${index}. ${baseName}${name} [${loc}]\n${c.description}`
    })
    .join('\n\n')
}

function coerceJson<T>(text: string, schema: z.ZodType<T>): T {
  const tryParse = (s: string) => {
    try {
      const obj = JSON.parse(s)
      return schema.parse(obj)
    } catch {
      return undefined
    }
  }
  const direct = tryParse(text.trim())
  if (direct) return direct
  // Try to find the first JSON object substring
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    const m = tryParse(match[0]!)
    if (m) return m
  }
  throw new Error('Model did not return valid JSON for PickChunksSchema')
}

export async function pickChunks(
  prompt: string,
  inputChunks: AnnotatedChunk[],
  options: PickChunksOptions,
): Promise<{ chunks: AnnotatedChunk[]; indices: number[]; usage?: any }> {
  const apiKey = options.apiKey
  const model = options.model || 'gpt-5-nano'
  const maxItems = options.maxItems ?? 120

  const presented = inputChunks.slice(0, maxItems)
  const filesBlock = chunkListToPrompt(presented)

  const system = `You are a senior software engineer. You are deciding which code chunks are most relevant to read to answer a prompt.\n\nYou will be provided a list of code chunks with file, optional symbol name, and line range plus a short snippet.\n\nPick ALL chunks that might be relevant. Return ONLY a JSON object of the form {"chunks": [indices...]}, where indices refer to the list provided. Do not include any extra text.`

  const user = `CHUNKS_TO_PICK_FROM:\n${filesBlock}\n\nPROMPT:\n${prompt}`

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: `${system}\n\n${user}` }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI pickChunks error: ${res.status} ${body}`)
  }

  const data: any = await res.json()
  const text: string = (data.output || [])
    .filter((o: any) => o.type === 'message')
    .map((o: any) => (o.content || []).map((c: any) => c.text).join(''))
    .join('\n')

  const parsed = coerceJson(text, PickChunksSchema)
  const indices = parsed.chunks
    .map((i) => (Number.isFinite(i) ? Math.trunc(i) : -1))
    .filter((i) => i >= 0 && i < presented.length)

  const selected = indices.map((i) => presented[i]!).filter(Boolean)

  // Console diagnostics similar to pickDocs
  console.log(`CHUNKS_TO_PICK_FROM:\n${filesBlock}\n\nPICKED_CHUNKS:\n${indices.join(', ')}`)

  return { chunks: selected, indices, usage: data.usage }
}
