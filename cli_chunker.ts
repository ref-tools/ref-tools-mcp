#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chunkCodebase, chunkFile, type Chunk } from './chunker'

export type CliFormat = 'json' | 'human'

function usage(): string {
  return [
    'code-chunker - chunk a codebase into function/class/file units',
    '',
    'Usage:',
    '  code-chunker --root <dir> [--out <file>] [--format human|json] [options]',
    '  code-chunker --file <path> [--out <file>] [--format human|json] [options]',
    '',
    'Inputs:',
    '  --root <dir>         Root directory to scan (defaults to current working directory)',
    '  --file <path>        Process a single file instead of scanning a directory',
    '',
    'Options:',
    '  --format <fmt>       Output format: "human" (default) or "json"',
    '  --out <file>         Output file path (if omitted, prints to stdout)',
    '  --array              With --format json, write a JSON array instead of JSONL',
    '  --pretty             Pretty-print JSON output',
    '  --languages <list>   Comma-separated list of languages to enable',
    '                       Available: javascript, typescript, tsx, python, java, ruby, c',
    '  -h, --help           Show this help and exit',
    '',
    'Examples:',
    '  code-chunker --root .',
    '  code-chunker --root . --out chunks.txt',
    '  code-chunker --root ./repo --out chunks.jsonl --format json',
    '  code-chunker --root ./repo --out chunks.json --format json --array --pretty',
    '  code-chunker --root ./repo --out ts-only.txt --languages typescript,tsx',
    '  code-chunker --file ./src/index.ts --format json',
    '  code-chunker --file ./src/index.ts --out single.jsonl --format json',
  ].join('\n')
}

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
    if (!a) continue
    if (a === '-h' || a === '--help') {
      args.help = true
      continue
    }
    if (a.startsWith('--')) {
      const eqIndex = a.indexOf('=')
      const key = eqIndex >= 0 ? a.slice(2, eqIndex) : a.slice(2)
      const val = eqIndex >= 0 ? a.slice(eqIndex + 1) : undefined
      if (typeof val === 'undefined') {
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          args[key] = next
          i++
        } else {
          args[key] = true
        }
      } else {
        args[key] = val
      }
    } else {
      positionals.push(a)
    }
  }
  return { args, positionals }
}

async function run() {
  const { args } = parseArgs(process.argv)
  if (args.help) {
    console.log(usage())
    process.exit(0)
  }

  const root = (args.root as string) || process.cwd()
  const fileInput = args.file as string | undefined
  const out = args.out as string | undefined
  const formatInput = (args.format as string) || 'human'
  const format = (formatInput === 'json' || formatInput === 'human' ? formatInput : undefined) as
    | CliFormat
    | undefined
  const jsonMode = format === 'json'
  const jsonArray = !!args.array
  const pretty = !!args.pretty
  const languages = (args.languages as string | undefined)?.split(',').map((s) => s.trim())

  if (!format) {
    console.error(`Error: Invalid --format ${JSON.stringify(formatInput)}\n`)
    console.log(usage())
    process.exit(2)
  }

  let chunks: Chunk[] = []
  let relativeBase = root
  if (fileInput) {
    const absFile = path.resolve(fileInput)
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
      console.error(`Error: --file does not exist or is not a file: ${JSON.stringify(fileInput)}\n`)
      console.log(usage())
      process.exit(2)
    }
    const res = await chunkFile(absFile, { languages })
    chunks = res ?? []
    relativeBase = path.dirname(absFile)
  } else {
    chunks = await chunkCodebase(root, { languages })
    relativeBase = root
  }

  if (jsonMode) {
    if (out) {
      writeJsonChunks(out, chunks, { format: jsonArray ? 'array' : 'jsonl', pretty })
    } else {
      if (jsonArray) {
        const prettySpaces = pretty ? 2 : undefined
        console.log(JSON.stringify(chunks, null, prettySpaces))
      } else {
        for (const c of chunks) console.log(JSON.stringify(c))
      }
    }
  } else {
    const text = toHumanReadable(chunks, { relativeTo: relativeBase })
    if (out) {
      fs.writeFileSync(out, text)
    } else {
      console.log(text)
    }
  }
}

const argv1 = process.argv[1]
const isDirectRun = argv1 ? import.meta.url === pathToFileURL(argv1).href : false
if (isDirectRun) {
  run().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export default run
