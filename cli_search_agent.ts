#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import SearchAgent, {
  type QueryResult,
  type AgentStreamEvent,
  runAgentWithStreaming,
} from './search_agent'
import { makeOpenAIAnnotator } from './openai_searchdb'
import { pickChunksFilter } from './pickdocs'

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
    '  --agent             Use LLM agent (AI SDK) with streaming output',
    '  --mode <m>          Agent mode: findContext | answer (default: answer)',
    '  --model <name>      Agent model (default: gpt-5)',
    '  --api-key <key>     OpenAI API key (or set OPENAI_API_KEY)',
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
  const useAgent = !!args.agent
  const agentMode = (
    (args.mode as string | undefined) === 'findContext' ? 'findContext' : 'answer'
  ) as 'findContext' | 'answer'
  const model = (args.model as string | undefined) || 'gpt-5'
  const apiKey = (args['api-key'] as string | undefined) || process.env.OPENAI_API_KEY

  const s = spinner('Indexing repository...')
  const agent = new SearchAgent(root, {
    languages,
    useOpenAI: useAgent,
    agentModel: model,
    openaiApiKey: apiKey || undefined,
    annotator: apiKey ? makeOpenAIAnnotator({ apiKey }) : undefined,
    relevanceFilter: apiKey ? pickChunksFilter : undefined,
  })
  await agent.ingest()
  s.stop('Index ready.')

  if (useAgent) {
    console.log(`Agent starting. mode=${agentMode} query='${query}'`)
    const render = (e: AgentStreamEvent) => {
      if (e.type === 'tool_call') {
        const params = e.name === 'search_graph' ? e.input?.cypher : e.input?.query
        console.log(`→ Tool ${e.name}(${JSON.stringify(params)})`)
      } else if (e.type === 'tool_result') {
        const summary = `${(e.output as any[]).length} chunk(s)`
        console.log(`✓ Result from ${e.name}: ${summary}`)
      } else if (e.type === 'text_delta') {
        process.stdout.write(e.text)
      } else if (e.type === 'text_complete') {
        // newline after streaming text
        if (!e.text.endsWith('\n')) console.log()
      } else if (e.type === 'final') {
        console.log('\n---\n')
        console.log(e.markdown)
      }
    }
    await runAgentWithStreaming(agent, query, render, agentMode)
    return
  }

  const s2 = spinner('Running query...')
  const result: QueryResult = await agent.search(query)
  s2.stop('Done.')

  if (result.kind === 'graph') {
    for (const c of result.chunks) {
      const lines = `${c.line}-${c.endLine}`
      console.log(`• ${path.relative(root, c.filePath)} @ ${lines} (${c.language}) ${c.name || ''}`)
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
