#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { SearchDB, defaultAnnotator } from './searchdb'
import { makeOpenAIAnnotator } from './openai_searchdb'
import type { Chunk } from './chunker'
import { pickChunksFilter } from './pickdocs'

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
  console.log(
    `Usage: tsx cli_searchdb.ts [options]\n\n` +
      `Options:\n` +
      `  --file, -f <path>     File to read content from\n` +
      `  --text, -t <string>   Inline content (if no --file)\n` +
      `  --mode, -m <mode>     One of label|embed|both (default: both)\n` +
      `  --openai              Use OpenAI for label + embeddings\n` +
      `  --api-key <key>       OpenAI API key (or set OPENAI_API_KEY)\n` +
      `  --label-model <name>  Label model (default: gpt-5-nano)\n` +
      `  --embed-model <name>  Embedding model (default: text-embedding-3-small)\n`,
  )
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// OpenAI-specific helpers have been moved to openai_searchdb.ts

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file && !args.text) {
    printHelp()
    process.exit(1)
  }
  const apiKey = args.apiKey || process.env.OPENAI_API_KEY || ''
  const labelModel = args.labelModel || 'gpt-5-nano'
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

  const annotator = args.openai
    ? makeOpenAIAnnotator({ apiKey, labelModel, embedModel })
    : defaultAnnotator

  const db = new SearchDB({ annotator, relevanceFilter: pickChunksFilter })
  await db.addChunk(chunk)

  if (args.mode === 'label' || args.mode === 'both') {
    const { description } = await annotator.labelAndEmbed(chunk)
    console.log('Label:', description)
  }
  if (args.mode === 'embed' || args.mode === 'both') {
    const { description } = await annotator.labelAndEmbed(chunk)
    const vec = await annotator.embed(`${description}\n\n${chunk.content}`)
    console.log('Embedding dim:', vec.length)
    console.log(
      'Embedding preview:',
      vec
        .slice(0, 8)
        .map((v: number) => v.toFixed(4))
        .join(', '),
    )
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
