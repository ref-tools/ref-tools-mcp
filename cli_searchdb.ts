#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { SearchDB, defaultEmbedder, defaultLabeler } from './searchdb'
import type { Chunk } from './chunker'

type Args = {
  file?: string
  text?: string
  mode?: 'label' | 'embed' | 'both'
  openai?: boolean
  apiKey?: string
  labelModel?: string
  embedModel?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'both', openai: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--file' || a === '-f') args.file = next()
    else if (a === '--text' || a === '-t') args.text = next()
    else if (a === '--mode' || a === '-m') args.mode = (next() as any) || 'both'
    else if (a === '--openai') args.openai = true
    else if (a === '--api-key') args.apiKey = next()
    else if (a === '--label-model') args.labelModel = next()
    else if (a === '--embed-model') args.embedModel = next()
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  console.log(`Usage: tsx cli_searchdb.ts [options]\n\n` +
    `Options:\n` +
    `  --file, -f <path>     File to read content from\n` +
    `  --text, -t <string>   Inline content (if no --file)\n` +
    `  --mode, -m <mode>     One of label|embed|both (default: both)\n` +
    `  --openai              Use OpenAI for label + embeddings\n` +
    `  --api-key <key>       OpenAI API key (or set OPENAI_API_KEY)\n` +
    `  --label-model <name>  Label model (default: gpt5-nano)\n` +
    `  --embed-model <name>  Embedding model (default: text-embedding-3-small)\n`)
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

async function openaiLabeler(apiKey: string, model: string) {
  return async (chunk: Chunk): Promise<string> => {
    const prompt = `Briefly (\u003c30 words) label this code, including key function names if present.\n` +
      `File: ${path.basename(chunk.filePath)}\n` +
      `Lines: ${chunk.line}-${chunk.endLine}\n` +
      `Content:\n${chunk.content}`
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: prompt,
      }),
    })
    if (!res.ok) throw new Error(`OpenAI label error: ${res.status} ${await res.text()}`)
    const data: any = await res.json()
    const text: string = data.output_text || data.content?.[0]?.text || data.choices?.[0]?.message?.content || ''
    return text.trim().split(/\s+/).slice(0, 30).join(' ')
  }
}

async function openaiEmbedder(apiKey: string, model: string) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file && !args.text) {
    printHelp()
    process.exit(1)
  }
  const apiKey = args.apiKey || process.env.OPENAI_API_KEY || ''
  const labelModel = args.labelModel || 'gpt5-nano'
  const embedModel = args.embedModel || 'text-embedding-3-small'

  const content = args.file ? fs.readFileSync(args.file, 'utf8') : (args.text as string)
  const filePath = args.file || path.join(process.cwd(), 'snippet.txt')
  const chunk: Chunk = {
    id: 'cli-' + Date.now(),
    filePath,
    language: path.extname(filePath).slice(1) || 'text',
    type: 'snippet',
    name: path.basename(filePath),
    line: 1,
    endLine: (content.match(/\n/g) || []).length + 1,
    content,
    contentHash: sha256Hex(content),
    relations: [],
  }

  const labeler = args.openai ? (await openaiLabeler(apiKey, labelModel)) : defaultLabeler
  const embedder = args.openai ? (await openaiEmbedder(apiKey, embedModel)) : defaultEmbedder

  const db = new SearchDB({ labeler, embedder })
  await db.addChunk(chunk)

  if (args.mode === 'label' || args.mode === 'both') {
    const desc = await labeler(chunk)
    console.log('Label:', desc)
  }
  if (args.mode === 'embed' || args.mode === 'both') {
    const desc = await labeler(chunk)
    const vec = await embedder(`${desc}\n\n${chunk.content}`)
    console.log('Embedding dim:', vec.length)
    console.log('Embedding preview:', vec.slice(0, 8).map((v) => v.toFixed(4)).join(', '))
  }
}

// Run if executed directly
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

