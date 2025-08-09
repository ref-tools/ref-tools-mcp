import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chunkCodebase, chunkFile, type Chunk } from './chunker'
import { GraphDB } from './graphdb'
import { SearchDB, type ChunkAnnotator, type RelevanceFilter } from './searchdb'

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

export type QueryResult =
  | { kind: 'graph'; rows: any[] }
  | { kind: 'search'; chunks: Chunk[] }

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

  constructor(private rootDir: string, private opts: SearchAgentOptions = {}) {
    this.db = new SearchDB({
      annotator: opts.annotator,
      relevanceFilter: opts.relevanceFilter,
    })
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
        return await this.searchWithLLMAgent(q)
      } catch {
        // fall through to heuristic routing
      }
    }
    const looksLikeCypher = /^(MATCH|CREATE)\b/i.test(q) || /^cypher:/i.test(q)
    if (looksLikeCypher) {
      const cy = q.replace(/^cypher:/i, '').trim()
      return { kind: 'graph', rows: this.graph.run(cy) }
    }
    const chunks = await this.db.search(q)
    return { kind: 'search', chunks }
  }

  search_graph(cypher: string): any[] {
    return this.graph.run(cypher)
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

    // Rechunk and update DB for changed files
    for (const f of changedFiles) {
      const oldIds = this.fileToChunkIds.get(f)
      if (oldIds) {
        for (const id of oldIds) this.db.removeChunk(id)
        this.fileToChunkIds.delete(f)
      }
      const res = await chunkFile(f, { languages: this.opts.languages })
      if (!res) continue
      await this.db.addChunks(res)
      const set = new Set<string>(res.map((c) => c.id))
      this.fileToChunkIds.set(f, set)
    }

    // rebuild graph and root
    this.rebuildGraphFromChunks()
    this.merkleRoot = merkleRoot(Array.from(this.merkleLeaves.entries()))
  }

  private async searchWithLLMAgent(query: string): Promise<QueryResult> {
    const apiKey = this.opts.openaiApiKey || process.env.OPENAI_API_KEY!
    const model = this.opts.agentModel || 'gpt-5'
    const decision = await routeWithOpenAI(apiKey, model, query)
    if (decision.tool === 'search_graph') {
      const cy = decision.input
      return { kind: 'graph', rows: this.graph.run(cy) }
    } else {
      const chunks = await this.db.search(decision.input)
      return { kind: 'search', chunks }
    }
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
  for (const c of chunks) {
    for (const r of c.relations || []) {
      const from = idToVar.get(c.id)
      const to = idToVar.get(r.targetId)
      if (!from || !to) continue
      const t = r.type.toUpperCase()
      rels.push(`(${from})-[:${t}]->(${to})`)
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

// -------- Optional LLM Agent routing (OpenAI Responses) --------
export async function routeWithOpenAI(
  apiKey: string,
  model: string,
  query: string,
): Promise<{ tool: 'search_graph' | 'search_query'; input: string }> {
  const system =
    'You route developer queries to tools. Choose exactly one tool. If the input is a Cypher graph query, pick search_graph with the cypher. Otherwise, pick search_query.'
  const schema = {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: ['search_graph', 'search_query'] },
      input: { type: 'string' },
    },
    required: ['tool', 'input'],
    additionalProperties: false,
  }
  const body = {
    model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: query },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'route', schema } },
  }
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`route error ${res.status}`)
  const data: any = await res.json()
  const text: string = data.output
    .filter((o: any) => o.type === 'message')
    .map((o: any) => o.content.map((c: any) => c.text).join(''))
    .join('\n')
  const parsed = JSON.parse(text)
  if (parsed.tool !== 'search_graph' && parsed.tool !== 'search_query')
    throw new Error('bad tool')
  return parsed
}

// (class method defined above)
