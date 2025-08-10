import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chunkCodebase, chunkFile, type Chunk } from './chunker'
import { GraphDB, rowsToChunks } from './graphdb'
import { SearchDB, type ChunkAnnotator, type RelevanceFilter } from './searchdb'
// pickChunks is only used via pickChunksFilter when configured
import { streamText, tool as aiTool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

export type SearchAgentOptions = {
  languages?: string[]
  annotator?: ChunkAnnotator
  relevanceFilter?: RelevanceFilter
  watch?: boolean
  pollIntervalMs?: number
  useOpenAI?: boolean
  openaiApiKey?: string
  agentModel?: string // default: gpt-5
}

export type QueryResult = { kind: 'graph'; chunks: Chunk[] } | { kind: 'search'; chunks: Chunk[] }

export type AgentMode = 'findContext' | 'answer'

/**
 * SearchAgent ingests a codebase directory into chunks, builds embeddings + a graph,
 * serves hybrid semantic+keyword search, and supports graph queries (Cypher subset).
 * It also supports a lightweight watcher using a Merkle tree of file hashes to
 * incrementally update the indexes on change.
 */
export class SearchAgent {
  private db: SearchDB
  private graph: GraphDB = new GraphDB()
  private fileToChunkIds = new Map<string, Set<string>>()
  private merkleLeaves = new Map<string, string>() // filePath -> sha256(content)
  private merkleRoot = ''
  private watcherTimer?: NodeJS.Timeout

  constructor(
    private rootDir: string,
    private opts: SearchAgentOptions = {},
  ) {
    // console.log('opts', opts)
    this.db = new SearchDB({ annotator: opts.annotator, relevanceFilter: opts.relevanceFilter })
  }

  // -------- Public API --------
  async ingest(): Promise<void> {
    const chunks = await chunkCodebase(this.rootDir, { languages: this.opts.languages })
    await this.db.addChunks(chunks)
    this.rebuildGraphFromChunks()
    this.rebuildMerkle(chunks)
    if (this.opts.watch) this.startWatcher()
  }

  async search(query: string): Promise<QueryResult> {
    const q = query.trim()
    if (this.opts.useOpenAI && (this.opts.openaiApiKey || process.env.OPENAI_API_KEY)) {
      try {
        // Run the interactive agent, but still return programmatic chunks for callers.
        await runAgentWithStreaming(this, q)
      } catch {
        // fall through to heuristic routing
      }
    }
    const chunks = await this.db.search(q)
    return { kind: 'search', chunks }
  }

  search_graph(cypher: string): Chunk[] {
    const rows = this.graph.run(cypher)
    const all: Chunk[] = (this.db as any).listChunks()
    return rowsToChunks(rows, all)
  }

  async search_query(prompt: string): Promise<Chunk[]> {
    return this.db.search(prompt)
  }

  getMerkleRoot(): string {
    return this.merkleRoot
  }

  stopWatcher(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer)
    this.watcherTimer = undefined
  }

  // -------- Internal helpers --------
  private rebuildGraphFromChunks(): void {
    const chunks = this.db.listChunks()
    this.graph = new GraphDB()
    const { cypher } = buildCreateCypherForChunks(chunks)
    if (cypher) this.graph.run(cypher)

    // refresh file -> chunk ids map
    this.fileToChunkIds.clear()
    for (const c of chunks) {
      const set = this.fileToChunkIds.get(c.filePath) || new Set<string>()
      set.add(c.id)
      this.fileToChunkIds.set(c.filePath, set)
    }
  }

  private rebuildMerkle(chunks: Chunk[]): void {
    this.merkleLeaves.clear()
    // Compute per-file leaf hashes using raw file content
    const seen = new Set<string>()
    for (const c of chunks) {
      if (seen.has(c.filePath)) continue
      seen.add(c.filePath)
      try {
        const buf = fs.readFileSync(c.filePath)
        const h = sha256Hex(buf)
        this.merkleLeaves.set(c.filePath, h)
      } catch {
        // ignore missing files
      }
    }
    this.merkleRoot = merkleRoot(Array.from(this.merkleLeaves.entries()))
  }

  private startWatcher(): void {
    const interval = this.opts.pollIntervalMs ?? 750
    this.stopWatcher()
    this.watcherTimer = setInterval(() => {
      void this.pollOnce()
    }, interval)
  }

  private async pollOnce(): Promise<void> {
    // scan files under root with a similar filter as chunker
    const files = walkDirSimple(this.rootDir)
    const changedFiles: string[] = []
    const removedFiles = new Set(this.merkleLeaves.keys())

    for (const f of files) {
      removedFiles.delete(f)
      let h = ''
      try {
        const buf = fs.readFileSync(f)
        h = sha256Hex(buf)
      } catch {
        continue
      }
      const prev = this.merkleLeaves.get(f)
      if (prev !== h) {
        this.merkleLeaves.set(f, h)
        changedFiles.push(f)
      }
    }

    // Handle removed files
    for (const f of removedFiles) {
      this.merkleLeaves.delete(f)
      const ids = this.fileToChunkIds.get(f)
      if (ids) {
        for (const id of ids) this.db.removeChunk(id)
        this.fileToChunkIds.delete(f)
      }
    }

    if (changedFiles.length === 0 && removedFiles.size === 0) return

    // Rechunk and update DB for changed files in parallel batches
    const batchSize = 5
    for (let i = 0; i < changedFiles.length; i += batchSize) {
      const batch = changedFiles.slice(i, i + batchSize)
      await Promise.all(
        batch.map(async (f) => {
          const oldIds = this.fileToChunkIds.get(f)
          if (oldIds) {
            for (const id of oldIds) this.db.removeChunk(id)
            this.fileToChunkIds.delete(f)
          }
          const res = await chunkFile(f, { languages: this.opts.languages })
          if (!res) return
          await this.db.addChunks(res)
          const set = new Set<string>(res.map((c) => c.id))
          this.fileToChunkIds.set(f, set)
        }),
      )
    }

    // rebuild graph and root
    this.rebuildGraphFromChunks()
    this.merkleRoot = merkleRoot(Array.from(this.merkleLeaves.entries()))
  }
}

// ------- Builders -------

function esc(s: string | undefined | null): string {
  const v = s ?? ''
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function buildCreateCypherForChunks(chunks: Chunk[]): { cypher: string } {
  if (!chunks.length) return { cypher: '' }
  const idToVar = new Map<string, string>()
  const parts: string[] = []
  parts.push('CREATE ')
  // nodes
  for (const [i, c] of chunks.entries()) {
    const v = `c${i}`
    idToVar.set(c.id, v)
    const labels = c.type === 'file' ? 'File:Chunk' : 'Code:Chunk'
    const props = [
      `id: '${esc(c.id)}'`,
      `filePath: '${esc(c.filePath)}'`,
      `language: '${esc(c.language)}'`,
      `type: '${esc(c.type)}'`,
      `name: '${esc(c.name || '')}'`,
      `line: ${c.line}`,
      `endLine: ${c.endLine}`,
      `contentHash: '${esc(c.contentHash)}'`,
    ].join(', ')
    parts.push(`(${v}:${labels} { ${props} })`)
    if (i !== chunks.length - 1) parts.push(', ')
  }
  // relationships
  const rels: string[] = []
  const existingRelKeys = new Set<string>()
  for (const c of chunks) {
    for (const r of c.relations || []) {
      const from = idToVar.get(c.id)
      const to = idToVar.get(r.targetId)
      if (!from || !to) continue
      const t = r.type.toUpperCase()
      const key = `${t}|${from}|${to}`
      if (existingRelKeys.has(key)) continue
      existingRelKeys.add(key)
      rels.push(`(${from})-[:${t}]->(${to})`)
    }
  }

  // Build name -> definition ids map for classes/functions/methods/interfaces
  const definitionTypes = new Set<string>([
    'function_declaration',
    'method_definition',
    'class_declaration',
    'function_definition',
    'class_definition',
    'method_declaration',
    'interface_declaration',
    'class',
    'method',
    'function_definition',
  ])
  const nameToDefIds = new Map<string, Set<string>>()
  for (const c of chunks) {
    if (c.type !== 'file' && c.name && definitionTypes.has(c.type)) {
      const set = nameToDefIds.get(c.name) || new Set<string>()
      set.add(c.id)
      nameToDefIds.set(c.name, set)
    }
  }

  // For each chunk, tokenize content and create REFERENCES edges to any matching definitions by name
  const identifierRegex = /[A-Za-z_][A-Za-z0-9_$]*/g
  for (const c of chunks) {
    const from = idToVar.get(c.id)
    if (!from) continue
    if (!c.content) continue
    // Skip file-level chunks to avoid noisy, file-wide token matches creating spurious edges
    if (c.type === 'file') continue
    const seenTokens = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = identifierRegex.exec(c.content)) !== null) {
      const token = match[0]
      if (token.length < 3) continue
      if (seenTokens.has(token)) continue
      seenTokens.add(token)
      const targets = nameToDefIds.get(token)
      // Only create a REFERENCES edge when the identifier maps to a single, unique definition.
      // This avoids noisy edges for common names like "run", "init", etc. across many files.
      if (!targets || targets.size !== 1) continue
      const targetId = Array.from(targets)[0]!
      if (targetId === c.id) continue
      const to = idToVar.get(targetId)
      if (!to) continue
      const key = `REFERENCES|${from}|${to}`
      if (existingRelKeys.has(key)) continue
      existingRelKeys.add(key)
      rels.push(`(${from})-[:REFERENCES]->(${to})`)
    }
  }

  if (rels.length) {
    parts.push(', ')
    parts.push(rels.join(', '))
  }
  return { cypher: parts.join('') }
}

function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function merkleRoot(entries: [string, string][]): string {
  if (!entries.length) return ''
  // deterministic order
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  let layer = entries.map(([, h]) => h)
  if (layer.length === 1) return layer[0]!
  while (layer.length > 1) {
    const next: string[] = []
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) next.push(sha256Hex(layer[i]! + layer[i + 1]!))
      else next.push(layer[i]!)
    }
    layer = next
  }
  return layer[0]!
}

function walkDirSimple(root: string): string[] {
  const out: string[] = []
  const stack: string[] = ['.']
  while (stack.length) {
    const rel = stack.pop()!
    const abs = path.join(root, rel)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      for (const ent of fs.readdirSync(abs)) {
        const childRel = path.join(rel, ent)
        // skip node_modules by default
        if (/(^|\/)node_modules(\/|$)/.test(childRel)) continue
        stack.push(childRel)
      }
    } else {
      out.push(abs)
    }
  }
  return out
}

export default SearchAgent

// -------- Agent Streaming Types and Runner --------
export function createSearchGraphTool(self: SearchAgent) {
  return aiTool({
    description:
      'Run a Cypher query on the code graph and return matching chunks. Supported (subset): CREATE, MATCH (node-only or single hop), labels (:Label) and inline property filters, WHERE with =, !=, <, <=, >, >= and AND/OR/NOT, RETURN variables and properties, count(*), count(var), collect(var), AS aliases, DISTINCT, ORDER BY, LIMIT. Labels: Chunk, Code, File. Relationships: REFERENCES, CONTAINS. Introspection: CALL db.labels(). Note: chunks are extracted from returned node values. If you return only scalar properties (e.g., d.filePath), the tool will resolve filePath strings to their file chunks; returning node variables (e.g., RETURN d) is still recommended.',
    parameters: z.object({ cypher: z.string() }),
    execute: async ({ cypher }) => {
      const rows = (self as any)['graph'].run(cypher)
      const all: Chunk[] = (self as any)['db'].listChunks()
      const chunks = rowsToChunks(rows, all)
      return chunks.map((chunk: Chunk) => ({
        type: 'text',
        text: `${chunk.filePath} ${chunk.type === 'file' ? '' : `${chunk.line}-${chunk.endLine}`}\n---\n${chunk.content}`,
      }))
    },
  })
}

export function createSearchQueryTool(self: SearchAgent) {
  return aiTool({
    description:
      'Search the codebase for relevant chunks to a natural language query. Should be a full-sentance in natural language describing what you want to find.',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const chunks = await (self as any)['db'].search(query)
      return chunks.map((chunk: Chunk) => ({
        type: 'text',
        text: `${chunk.filePath} ${chunk.type === 'file' ? '' : `${chunk.line}-${chunk.endLine}`}\n---\n${chunk.content}`,
      }))
    },
  })
}
export type AgentStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text_complete'; text: string }
  | { type: 'tool_call'; name: 'search_graph' | 'search_query' | 'finalize_context'; input: any }
  | { type: 'tool_result'; name: 'search_graph' | 'search_query' | 'finalize_context'; output: any }
  | { type: 'final'; markdown: string }

export interface AgentRunResult {
  markdown: string
  chunks?: Chunk[]
  transcript?: string
}

export async function buildAgentMarkdownFromChunks(
  query: string,
  chunks: Chunk[],
  rootDir: string,
): Promise<string> {
  const lines: string[] = []
  lines.push(`# Search Results`)
  lines.push('')
  lines.push(`Query: ${query}`)
  lines.push('')
  if (chunks.length === 0) {
    lines.push('_No results._')
  } else {
    for (const c of chunks.slice(0, 10)) {
      const rel = path.relative(rootDir, c.filePath)
      lines.push(`- ${rel} : lines ${c.line}-${c.endLine} — ${c.name || c.type}`)
    }
  }
  return lines.join('\n')
}

export async function buildAgentMarkdownFromRows(query: string, rows: any[]): Promise<string> {
  const lines: string[] = []
  lines.push(`# Graph Query Results`)
  lines.push('')
  lines.push('```cypher')
  lines.push(query)
  lines.push('```')
  lines.push('')
  if (rows.length === 0) {
    lines.push('_No rows._')
  } else {
    for (const [i, r] of rows.entries()) {
      lines.push(`- Row ${i + 1}: \n  \`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``)
    }
  }
  return lines.join('\n')
}

export async function runAgentWithStreaming(
  self: SearchAgent,
  query: string,
  onStream?: (e: AgentStreamEvent) => void,
  mode: AgentMode = 'answer',
): Promise<AgentRunResult> {
  const apiKey = self['opts'].openaiApiKey || process.env.OPENAI_API_KEY
  const modelName = self['opts'].agentModel || 'gpt-5'

  if (!apiKey) {
    // Fallback: heuristic single-step plan
    onStream?.({ type: 'tool_call', name: 'search_query', input: { query } })
    const chunks = await (self as any)['db'].search(query)
    onStream?.({ type: 'tool_result', name: 'search_query', output: chunks })
    if (mode === 'findContext') {
      onStream?.({ type: 'tool_call', name: 'finalize_context', input: { finalize: true } })
      onStream?.({ type: 'tool_result', name: 'finalize_context', output: chunks })
      const md = await buildAgentMarkdownFromChunks(query, chunks, (self as any)['rootDir'])
      onStream?.({ type: 'final', markdown: md })
      return { markdown: md, chunks: chunks }
    }
    // answer mode: stream a brief transcript-like text then final markdown
    onStream?.({ type: 'text_delta', text: 'Planning search...\n' })
    onStream?.({ type: 'text_delta', text: 'Searching codebase...\n' })
    const md = await buildAgentMarkdownFromChunks(query, chunks, (self as any)['rootDir'])
    onStream?.({ type: 'final', markdown: md })
    return { markdown: md, transcript: 'Planning search...\nSearching codebase...\n' + md }
  }

  const openai = createOpenAI({ apiKey })
  const searchGraph = createSearchGraphTool(self)
  const searchQuery = createSearchQueryTool(self)

  // finalize_context tool is only meaningful in findContext mode; it lets the model choose chunk ids
  const finalizeContext = aiTool({
    description: 'Finalize the minimal set of relevant chunk ids to return as context.',
    parameters: z.object({ chunkIds: z.array(z.string()).min(1) }),
    execute: async ({ chunkIds }) => {
      const all: Chunk[] = (self as any)['db'].listChunks()
      const selected = all.filter((c) => chunkIds.includes(c.id))
      return selected.map((chunk) => ({
        type: 'text',
        text: `${chunk.filePath} ${chunk.type === 'file' ? '' : `${chunk.line}-${chunk.endLine}`}\n---\n${chunk.content}`,
      }))
    },
  })

  const result = streamText({
    model: openai(modelName),
    system:
      mode === 'findContext'
        ? 'You are a repository search agent. Use search tools to find relevant code. When ready, call finalize_context with a minimal set of chunkIds. Do not include unnecessary chunks.'
        : 'You are a helpful repository research agent. Call tools as needed and narrate your reasoning. Provide a concise markdown summary at the end.',
    messages: [
      {
        role: 'user',
        content: `Look through the codebase to find relevant information and answer the following query:\n${query}`,
      },
    ],
    tools:
      mode === 'findContext'
        ? {
            search_graph: searchGraph,
            search_query: searchQuery,
            finalize_context: finalizeContext,
          }
        : { search_graph: searchGraph, search_query: searchQuery },
    maxSteps: 10,
  })

  let finalText = ''
  for await (const ev of result.fullStream) {
    if ((ev as any).type === 'text-delta') {
      // @ts-ignore - ai-sdk v4 event shape
      const t = (ev as any).textDelta || (ev as any).text || ''
      finalText += t
      onStream?.({ type: 'text_delta', text: t })
    }
    if ((ev as any).type === 'tool-call') {
      const name = ((ev as any).toolName || 'search_query') as 'search_graph' | 'search_query'
      onStream?.({ type: 'tool_call', name, input: (ev as any).args })
    }
    if ((ev as any).type === 'tool-result') {
      const name = ((ev as any).toolName || 'search_query') as 'search_graph' | 'search_query'
      onStream?.({ type: 'tool_result', name, output: (ev as any).result })
    }
  }
  onStream?.({ type: 'text_complete', text: finalText })
  const markdown =
    finalText || (await buildAgentMarkdownFromChunks(query, [], (self as any)['rootDir']))
  onStream?.({ type: 'final', markdown })
  // Note: without introspecting the tool results thread, we cannot programmatically pluck finalized chunks here.
  // Callers should process tool_result events for finalize_context to capture selected chunks.
  return { markdown, transcript: finalText }
}

export interface RunAgentOptions {
  onStream?: (e: AgentStreamEvent) => void
}
export async function runAgent(
  this: SearchAgent,
  query: string,
  opts?: RunAgentOptions,
): Promise<AgentRunResult> {
  return runAgentWithStreaming(this, query, opts?.onStream)
}

// -------- Optional LLM Agent routing (OpenAI Responses) --------
// (end streaming helpers)
