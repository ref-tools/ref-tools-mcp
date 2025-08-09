import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Chunk } from './chunker'
import type { ChunkAnnotator, Annotation } from './searchdb'

export type OpenAIAnnotatorOptions = {
  apiKey: string
  labelModel?: string // e.g., 'gpt5-nano'
  embedModel?: string // e.g., 'text-embedding-3-small'
  cachePath?: string // defaults to ~/.ref/search-cache.json
}

type CacheEntry = { embedding: number[]; description: string }

function defaultCachePath(): string {
  const dir = path.join(os.homedir(), '.ref')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'search-cache.json')
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeCache(file: string, data: Record<string, CacheEntry>) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

export function makeOpenAIAnnotator(opts: OpenAIAnnotatorOptions): ChunkAnnotator {
  const apiKey = opts.apiKey
  const labelModel = opts.labelModel || 'gpt5-nano'
  const embedModel = opts.embedModel || 'text-embedding-3-small'
  const cacheFile = opts.cachePath || defaultCachePath()
  let cache = readCache(cacheFile)

  async function openaiLabel(chunk: Chunk): Promise<string> {
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
      body: JSON.stringify({ model: labelModel, input: prompt }),
    })
    if (!res.ok) throw new Error(`OpenAI label error: ${res.status} ${await res.text()}`)
    const data: any = await res.json()
    const text: string = data.output_text || data.content?.[0]?.text || data.choices?.[0]?.message?.content || ''
    return text.trim().split(/\s+/).slice(0, 30).join(' ')
  }

  async function openaiEmbed(text: string): Promise<number[]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: embedModel, input: text }),
    })
    if (!res.ok) throw new Error(`OpenAI embed error: ${res.status} ${await res.text()}`)
    const data: any = await res.json()
    const vec: number[] = data.data?.[0]?.embedding
    if (!Array.isArray(vec)) throw new Error('Invalid embedding response')
    return vec
  }

  return {
    async labelAndEmbed(chunk: Chunk): Promise<Annotation> {
      const key = chunk.contentHash || sha256Hex(chunk.content)
      const hit = cache[key]
      if (hit) return hit
      const description = await openaiLabel(chunk)
      const combined = `${description}\n\n${chunk.content}`
      const embedding = await openaiEmbed(combined)
      const value = { description, embedding }
      cache[key] = value
      writeCache(cacheFile, cache)
      return value
    },
    async embed(text: string): Promise<number[]> {
      // We do not cache query embeddings by default
      return openaiEmbed(text)
    },
  }
}
