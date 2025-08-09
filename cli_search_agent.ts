#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import SearchAgent, { type QueryResult } from './search_agent'

function usage() {
  return [
    'search-agent - ingest a repo and run queries',
    '',
    'Usage:',
    '  search-agent --root <dir> --query <text> [options]',
    '',
    'Options:',
    '  --root <dir>        Root directory (default: cwd)',
    '  --languages <list>  Comma-separated languages to enable',
    '  --cypher            Treat --query as Cypher (graph query)',
    '  --watch             Keep a background watcher running',
    '  --bm25K <n>         BM25 candidates (default 5)',
    '  --knnK <n>          KNN candidates (default 5)',
    '  -h, --help          Show help',
  ].join('\n')
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') {
      args.help = true
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      const next = argv[i + 1]
      if (eq >= 0) {
        args[key] = a.slice(eq + 1)
      } else if (next && !next.startsWith('-')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    }
  }
  return args
}

function spinner(text: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  const interval = setInterval(() => {
    const f = frames[i++ % frames.length]
    process.stdout.write(`\r${f} ${text}   `)
  }, 80)
  return {
    stop: (final?: string) => {
      clearInterval(interval)
      process.stdout.write(`\r${final || ''}\n`)
    },
  }
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(usage())
    process.exit(0)
  }
  const root = (args.root as string) || process.cwd()
  const query = (args.query as string) || ''
  if (!query) {
    console.error('Missing --query\n')
    console.log(usage())
    process.exit(2)
  }
  const languages = (args.languages as string | undefined)?.split(',').map((s) => s.trim())
  const treatAsCypher = !!args.cypher

  const s = spinner('Indexing repository...')
  const agent = new SearchAgent(root, { languages })
  await agent.ingest()
  s.stop('Index ready.')

  const s2 = spinner('Running query...')
  const result: QueryResult = treatAsCypher
    ? { kind: 'graph', rows: agent.search_graph(query) as any[] }
    : await agent.search(query)
  s2.stop('Done.')

  if (result.kind === 'graph') {
    // pretty print rows
    for (const [idx, row] of result.rows.entries()) {
      console.log(`#${idx + 1}`, JSON.stringify(row, null, 2))
    }
  } else {
    for (const c of result.chunks) {
      const lines = `${c.line}-${c.endLine}`
      console.log(`• ${path.relative(root, c.filePath)} @ ${lines} (${c.language}) ${c.name || ''}`)
    }
  }

  if (args.watch) {
    console.log('Watcher running. Ctrl-C to exit.')
    // keep process alive; SearchAgent watcher runs on interval after ingest if watch enabled
    // enable watch mode by restarting agent with watcher on
    agent.stopWatcher()
    const agentWithWatch = new SearchAgent(root, { languages, watch: true })
    await agentWithWatch.ingest()
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
