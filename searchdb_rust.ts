import { createRequire } from 'node:module'
import { type AnnotatedChunk, type Chunk } from './chunker'
import { defaultAnnotator, type ChunkAnnotator, type RelevanceFilter } from './searchdb'

type NativeModule = {
  SearchIndex: new () => {
    addDoc(id: string, bm25_text: string, embedding: Float32Array): void
    updateDoc(id: string, bm25_text: string, embedding: Float32Array): void
    removeDoc(id: string): void
    unionCandidates(query: string, query_vec: Float32Array, bm25_k: number, knn_k: number): string[]
  }
}

function loadNative(): NativeModule['SearchIndex'] {
  const req = createRequire(import.meta.url)
  const candidates = [
    // common napi-rs layout if built via @napi-rs/cli
    './native/index.node',
    // local debug build suggestions
    './native/searchdb.node',
    './native/searchdb_native.node',
    // cargo target dirs (manual build)
    './native/searchdb-rs/target/release/searchdb_native.node',
    './native/searchdb-rs/target/debug/searchdb_native.node',
  ]
  let lastErr: any
  for (const rel of candidates) {
    try {
      const m = req(rel)
      if (m?.SearchIndex) return m.SearchIndex as NativeModule['SearchIndex']
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(
    `Could not load native SearchIndex. Tried: ${candidates.join(', ')}\nLast error: ${lastErr}`,
  )
}

export type SearchOptions = { knnK?: number; bm25K?: number }

export class RustSearchDB {
  private byId = new Map<string, AnnotatedChunk>()
  private native: InstanceType<ReturnType<typeof loadNative>>

  constructor(
    private opts: { annotator?: ChunkAnnotator; relevanceFilter?: RelevanceFilter } = {},
  ) {
    const Ctor = loadNative()
    this.native = new Ctor()
  }

  getChunk(id: string): AnnotatedChunk | undefined {
    return this.byId.get(id)
  }

  listChunks(): AnnotatedChunk[] {
    return Array.from(this.byId.values())
  }

  async addChunk(chunk: Chunk): Promise<void> {
    const annotator = this.opts.annotator || defaultAnnotator
    const { description, embedding } = await annotator.labelAndEmbed(chunk)
    const bm25Text = `${description}\n${chunk.content}`
    const emb = Float32Array.from(embedding.map((x) => (Number.isFinite(x) ? x : 0)))
    this.byId.set(chunk.id, { ...chunk, description, embedding })
    this.native.addDoc(chunk.id, bm25Text, emb)
  }

  async addChunks(chunks: Chunk[]): Promise<void> {
    const batchSize = 10
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      await Promise.all(batch.map((c) => this.addChunk(c)))
    }
  }

  async updateChunk(chunk: Chunk): Promise<void> {
    const annotator = this.opts.annotator || defaultAnnotator
    const { description, embedding } = await annotator.labelAndEmbed(chunk)
    const bm25Text = `${description}\n${chunk.content}`
    const emb = Float32Array.from(embedding.map((x) => (Number.isFinite(x) ? x : 0)))
    this.byId.set(chunk.id, { ...chunk, description, embedding })
    this.native.updateDoc(chunk.id, bm25Text, emb)
  }

  removeChunk(id: string): void {
    if (!this.byId.has(id)) return
    this.byId.delete(id)
    this.native.removeDoc(id)
  }

  async search(query: string, options: SearchOptions = {}): Promise<AnnotatedChunk[]> {
    const knnK = options.knnK ?? 10
    const bm25K = options.bm25K ?? 10
    const annotator = this.opts.annotator || defaultAnnotator
    const qVecArr = await annotator.embed(query)
    const qVec = Float32Array.from(qVecArr.map((x) => (Number.isFinite(x) ? x : 0)))
    const ids = this.native.unionCandidates(query, qVec, bm25K, knnK)
    const items = ids.map((id) => this.byId.get(id)).filter((c): c is AnnotatedChunk => !!c)

    const filter = this.opts.relevanceFilter
    if (filter) {
      try {
        const filtered = await filter(query, items)
        return filtered
      } catch {
        // ignore filter errors
      }
    }
    // Fallback heuristic: keep chunks sharing query tokens in name/content
    const q = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter(Boolean),
    )
    const filtered = items.filter((c) => {
      const hay = `${c.name ?? ''} ${c.content}`.toLowerCase()
      for (const t of q) if (hay.includes(t)) return true
      return false
    })
    return filtered.length ? filtered : items
  }
}

export default RustSearchDB
