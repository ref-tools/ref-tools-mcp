import path from 'node:path'
import crypto from 'node:crypto'
import { type AnnotatedChunk, type Chunk } from './chunker'

export type RelevanceFilter = (query: string, items: AnnotatedChunk[]) => Promise<AnnotatedChunk[]>

export type Annotation = { description: string; embedding: number[] }
export interface ChunkAnnotator {
  labelAndEmbed(chunk: Chunk): Promise<Annotation>
  embed(text: string): Promise<number[]>
}

export type SearchOptions = {
  knnK?: number
  bm25K?: number
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter(Boolean)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

class BM25Index {
  private df = new Map<string, number>()
  private tf = new Map<string, Map<string, number>>() // docId -> term -> tf
  private docLen = new Map<string, number>()
  private totalLen = 0
  private docs = new Set<string>()

  constructor(
    private k1 = 1.5,
    private b = 0.75,
  ) {}

  add(docId: string, text: string) {
    const terms = tokenize(text)
    const len = terms.length
    const tfMap = new Map<string, number>()
    for (const t of terms) tfMap.set(t, (tfMap.get(t) || 0) + 1)
    this.tf.set(docId, tfMap)
    this.docLen.set(docId, len)
    this.totalLen += len
    this.docs.add(docId)
    // df increments once per doc per term
    for (const term of new Set(terms)) this.df.set(term, (this.df.get(term) || 0) + 1)
  }

  remove(docId: string) {
    const tfMap = this.tf.get(docId)
    if (!tfMap) return
    // adjust df
    for (const term of tfMap.keys()) {
      const v = (this.df.get(term) || 1) - 1
      if (v <= 0) this.df.delete(term)
      else this.df.set(term, v)
    }
    const len = this.docLen.get(docId) || 0
    this.totalLen -= len
    this.docLen.delete(docId)
    this.tf.delete(docId)
    this.docs.delete(docId)
  }

  score(query: string): Map<string, number> {
    const qTerms = Array.from(new Set(tokenize(query)))
    const N = Math.max(1, this.docs.size)
    const avgdl = this.totalLen > 0 ? this.totalLen / N : 0.0001
    const scores = new Map<string, number>()
    for (const [docId, tfMap] of this.tf.entries()) {
      const dl = this.docLen.get(docId) || 0
      let s = 0
      for (const term of qTerms) {
        const tf = tfMap.get(term) || 0
        if (tf === 0) continue
        const df = this.df.get(term) || 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const denom = tf + this.k1 * (1 - this.b + (this.b * dl) / avgdl)
        s += idf * ((tf * (this.k1 + 1)) / (denom || 1e-9))
      }
      if (s !== 0) scores.set(docId, s)
    }
    return scores
  }
}

export class SearchDB {
  private byId = new Map<string, AnnotatedChunk>()
  private bm25 = new BM25Index()

  constructor(
    private opts: {
      annotator?: ChunkAnnotator
      relevanceFilter?: RelevanceFilter
    } = {},
  ) {
    // no-op
  }

  // CRUD
  getChunk(id: string): AnnotatedChunk | undefined {
    return this.byId.get(id)
  }

  listChunks(): AnnotatedChunk[] {
    return Array.from(this.byId.values())
  }

  async addChunk(chunk: Chunk): Promise<void> {
    const annotator = this.opts.annotator || defaultAnnotator
    const { description, embedding } = await annotator.labelAndEmbed(chunk)

    // Store and update BM25
    this.byId.set(chunk.id, { ...chunk, description, embedding })
    const bm25Text = `${description}\n${chunk.content}`
    this.bm25.add(chunk.id, bm25Text)
  }

  async addChunks(chunks: Chunk[]): Promise<void> {
    const batchSize = 10
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      await Promise.all(batch.map((c) => this.addChunk(c)))
    }
  }

  async updateChunk(chunk: Chunk): Promise<void> {
    this.removeChunk(chunk.id)
    await this.addChunk(chunk)
  }

  removeChunk(id: string): void {
    if (!this.byId.has(id)) return
    this.byId.delete(id)
    this.bm25.remove(id)
  }

  async search(query: string, options: SearchOptions = {}): Promise<AnnotatedChunk[]> {
    const knnK = options.knnK ?? 5
    const bm25K = options.bm25K ?? 5

    // BM25 candidates
    const bm25Scores = this.bm25.score(query)
    const bm25Candidates = Array.from(bm25Scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, bm25K)
      .map(([id]) => id)

    // KNN candidates
    const annotator = this.opts.annotator || defaultAnnotator
    const qVec = await annotator.embed(query)
    const knnCandidates = Array.from(this.byId.entries())
      .map(([id, e]) => ({ id, s: cosine(qVec, e.embedding) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, knnK)
      .map((x) => x.id)

    // Union
    const uniqueIds = Array.from(new Set([...bm25Candidates, ...knnCandidates]))

    // Candidate chunks
    const items = uniqueIds.map((id) => this.byId.get(id)).filter((c): c is AnnotatedChunk => !!c)

    // Final relevance filter over chunks if provided
    const filter = this.opts.relevanceFilter
    if (filter) {
      try {
        const filtered = await filter(query, items)
        return filtered
      } catch {
        // fall through to default
      }
    }

    // Default heuristic: keep chunks sharing query tokens in name/content
    const q = new Set(tokenize(query))
    const filtered = items.filter((c) => {
      const hay = `${c.name ?? ''} ${c.content}`.toLowerCase()
      return Array.from(q).some((t) => hay.includes(t))
    })
    return filtered.length ? filtered : items
  }
}

// -------------- Defaults (networked). Kept simple; tests should stub. --------------

export async function defaultLabeler(chunk: Chunk): Promise<string> {
  // Heuristic fallback if network is unavailable; include function name if present
  const name = chunk.name ? ` ${chunk.name}` : ''
  const base = `Code${name} in ${path.basename(chunk.filePath)} lines ${chunk.line}-${chunk.endLine}`
  // Keep description under 30 words
  return base.split(/\s+/).slice(0, 30).join(' ')
}

export async function defaultEmbedder(text: string): Promise<number[]> {
  // Simple deterministic embedding: hashing into a fixed-size vector
  const dim = 64
  const vec = new Array<number>(dim).fill(0)
  const tokens = tokenize(text)
  for (const t of tokens) {
    const h = crypto.createHash('sha256').update(t).digest()
    for (let i = 0; i < dim; i++) {
      const inc = (h[i % h.length] ?? 0) / 255
      const prev = vec[i] ?? 0
      vec[i] = prev + inc
    }
  }
  return vec
}

class DefaultAnnotatorImpl implements ChunkAnnotator {
  async labelAndEmbed(chunk: Chunk): Promise<Annotation> {
    const description = await defaultLabeler(chunk)
    const embedding = await defaultEmbedder(`${description}\n\n${chunk.content}`)
    return { description, embedding }
  }
  async embed(text: string): Promise<number[]> {
    return defaultEmbedder(text)
  }
}

export const defaultAnnotator: ChunkAnnotator = new DefaultAnnotatorImpl()
