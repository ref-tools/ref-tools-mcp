#!/usr/bin/env tsx
import { pathToFileURL } from 'node:url'
import SearchAgent from './search_agent'

function usage() {
  return [
    'graph - ingest a repo and run a Cypher query',
    '',
    'Usage:',
    '  graph --root <dir> --cypher <query> [--languages <list>]',
    '',
    'Examples:',
    '  graph --root . --cypher "MATCH (f:File:Chunk)-[:REFERENCES]->(g:File:Chunk) RETURN f.filePath AS from, g.filePath AS to LIMIT 20"',
  ].join('\n')
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') args.help = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      const next = argv[i + 1]
      if (eq >= 0) args[key] = a.slice(eq + 1)
      else if (next && !next.startsWith('-')) {
        args[key] = next
        i++
      } else args[key] = true
    }
  }
  return args
}

async function run() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(usage())
    process.exit(0)
  }
  const root = (args.root as string) || process.cwd()
  const cypher = (args.cypher as string) || ''
  if (!cypher) {
    console.error('Missing --cypher')
    console.log(usage())
    process.exit(2)
  }
  const languages = (args.languages as string | undefined)?.split(',').map((s) => s.trim())

  const agent = new SearchAgent(root, { languages })
  await agent.ingest()
  const rows = agent.search_graph(cypher)
  for (const [i, r] of rows.entries()) {
    console.log(`#${i + 1}`, JSON.stringify(r, null, 2))
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
