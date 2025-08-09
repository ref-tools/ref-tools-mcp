#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chunkCodebase, type Chunk } from './src/chunker'

export type CliFormat = 'json' | 'human'

export function toHumanReadable(chunks: Chunk[], opts?: { relativeTo?: string }): string {
  const rel = (p: string) => (opts?.relativeTo ? path.relative(opts.relativeTo, p) || '.' : p)
  const lines: string[] = []
  // Group by file for nicer output
  const byFile = new Map<string, Chunk[]>()
  for (const c of chunks) {
    const key = c.filePath
    const arr = byFile.get(key) || []
    arr.push(c)
    byFile.set(key, arr)
  }
  for (const [file, arr] of byFile) {
    lines.push(`File: ${rel(file)}  (chunks: ${arr.length})`)
    for (const c of arr) {
      const name = c.name ? ` ${c.name}` : ''
      lines.push(
        `  • [${c.language}] ${c.type}${name} @ ${c.line}-${c.endLine} #${c.id.slice(0, 8)}`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function writeJsonChunks(
  outFile: string,
  chunks: Chunk[],
  options?: { format?: 'jsonl' | 'array'; pretty?: boolean },
) {
  const fmt = options?.format ?? 'jsonl'
  const pretty = options?.pretty ? 2 : undefined
  if (fmt === 'array') {
    fs.writeFileSync(outFile, JSON.stringify(chunks, null, pretty))
  } else {
    const fd = fs.openSync(outFile, 'w')
    try {
      for (const c of chunks) {
        fs.writeSync(fd, JSON.stringify(c) + '\n')
      }
    } finally {
      fs.closeSync(fd)
    }
  }
}

export function readJsonChunks(inFile: string): Chunk[] {
  const data = fs.readFileSync(inFile, 'utf8').trim()
  if (!data) return []
  const first = data.trimStart()[0]
  if (first === '[') {
    return JSON.parse(data) as Chunk[]
  }
  const chunks: Chunk[] = []
  for (const line of data.split(/\r?\n/)) {
    if (!line.trim()) continue
    chunks.push(JSON.parse(line))
  }
  return chunks
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.split('=')
      if (typeof v === 'undefined') {
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          args[k.slice(2)] = next
          i++
        } else {
          args[k.slice(2)] = true
        }
      } else {
        args[k.slice(2)] = v
      }
    } else {
      positionals.push(a)
    }
  }
  return { args, positionals }
}

async function run() {
  const { args } = parseArgs(process.argv)
  const root = (args.root as string) || process.cwd()
  const out = args.out as string
  const format = ((args.format as string) || 'human') as CliFormat
  const jsonMode = format === 'json'
  const jsonArray = !!args.array
  const pretty = !!args.pretty
  const languages = (args.languages as string | undefined)?.split(',').map((s) => s.trim())

  const chunks = await chunkCodebase(root, { languages })

  if (!out) {
    console.error('Missing required --out <file>')
    process.exit(2)
  }

  if (jsonMode) {
    writeJsonChunks(out, chunks, { format: jsonArray ? 'array' : 'jsonl', pretty })
  } else {
    const text = toHumanReadable(chunks, { relativeTo: root })
    fs.writeFileSync(out, text)
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  run().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export default run
