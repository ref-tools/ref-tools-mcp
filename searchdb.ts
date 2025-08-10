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
  // Lowercase once to avoid per-token lowercase work
  const s = text.toLowerCase()
  const out: string[] = []
  const n = s.length
  let start = -1
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    const isWord = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95
    if (isWord) {
      if (start === -1) start = i
    } else if (start !== -1) {
      out.push(s.slice(start, i))
      start = -1
    }
  }
  if (start !== -1) out.push(s.slice(start))
  return out
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
  private postings = new Map<string, Map<string, number>>() // term -> (docId -> tf)
  private docLen = new Map<string, number>()
  private docTerms = new Map<string, string[]>() // docId -> unique terms present
  private totalLen = 0
  private docs = new Set<string>()

  constructor(
    private k1 = 1.5,
    private b = 0.75,
  ) {}

  add(docId: string, text: string) {
    const terms = tokenize(text)
    const len = terms.length
    if (len === 0) return
    const tfMap = new Map<string, number>()
    for (const t of terms) tfMap.set(t, (tfMap.get(t) || 0) + 1)
    const uniq: string[] = []
    for (const term of tfMap.keys()) uniq.push(term)
    for (const [term, tf] of tfMap) {
      let post = this.postings.get(term)
      if (!post) this.postings.set(term, (post = new Map()))
      post.set(docId, tf)
    }
    this.docLen.set(docId, len)
    this.totalLen += len
    this.docTerms.set(docId, uniq)
    this.docs.add(docId)
  }

  remove(docId: string) {
    if (!this.docs.has(docId)) return
    const terms = this.docTerms.get(docId)
    if (terms) {
      for (const term of terms) {
        const post = this.postings.get(term)
        if (!post) continue
        post.delete(docId)
        if (post.size === 0) this.postings.delete(term)
      }
    } else {
      // Fallback: scan all postings (shouldn't happen)
      for (const [, post] of this.postings) post.delete(docId)
    }
    const len = this.docLen.get(docId) || 0
    this.totalLen -= len
    this.docLen.delete(docId)
    this.docTerms.delete(docId)
    this.docs.delete(docId)
  }

  topK(query: string, topK: number): Array<[string, number]> {
    if (topK <= 0) return []
    const qTermsArr = tokenize(query)
    if (qTermsArr.length === 0) return []
    const seen = new Set<string>()
    const qTerms: string[] = []
    for (const t of qTermsArr)
      if (!seen.has(t)) {
        seen.add(t)
        qTerms.push(t)
      }
    const N = Math.max(1, this.docs.size)
    const avgdl = this.totalLen > 0 ? this.totalLen / N : 0.0001
    const scores = new Map<string, number>()
    const denomBaseCache = new Map<string, number>()
    for (const term of qTerms) {
      const post = this.postings.get(term)
      if (!post) continue
      const df = post.size
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      const mult = idf * (this.k1 + 1)
      for (const [docId, tf] of post) {
        let base = denomBaseCache.get(docId)
        if (base === undefined) {
          const dl = this.docLen.get(docId) || 0
          base = this.k1 * (1 - this.b + (this.b * dl) / avgdl)
          denomBaseCache.set(docId, base)
        }
        const denom = tf + base
        const s = mult * (tf / (denom || 1e-9))
        scores.set(docId, (scores.get(docId) || 0) + s)
      }
    }
    // min-heap selection
    const heapIds: string[] = []
    const heapS: number[] = []
    const push = (id: string, s: number) => {
      let i = heapIds.length
      heapIds.push(id)
      heapS.push(s)
      while (i > 0) {
        const p = (i - 1) >> 1
        if (heapS[p] <= s) break
        heapIds[i] = heapIds[p]
        heapS[i] = heapS[p]
        i = p
      }
      heapIds[i] = id
      heapS[i] = s
    }
    const pop = () => {
      const last = heapIds.length - 1
      heapIds[0] = heapIds[last]
      heapS[0] = heapS[last]
      heapIds.pop()
      heapS.pop()
      let i = 0
      const n = heapIds.length
      while (true) {
        const l = i * 2 + 1
        const r = l + 1
        if (l >= n) break
        const si = r < n && heapS[r] < heapS[l] ? r : l
        if (heapS[i] <= heapS[si]) break
        const tid = heapIds[i]
        const ts = heapS[i]
        heapIds[i] = heapIds[si]
        heapS[i] = heapS[si]
        heapIds[si] = tid
        heapS[si] = ts
        i = si
      }
    }
    for (const [id, s] of scores) {
      if (heapIds.length < topK) push(id, s)
      else if (s > heapS[0]) {
        pop()
        push(id, s)
      }
    }
    const out: Array<[string, number]> = heapIds.map((id, i) => [id, heapS[i]])
    out.sort((a, b) => b[1] - a[1])
    return out
  }

  score(query: string): Map<string, number> {
    const pairs = this.topK(query, Number.MAX_SAFE_INTEGER)
    const m = new Map<string, number>()
    for (const [id, s] of pairs) m.set(id, s)
    return m
  }
}

// High-performance exact cosine KNN over normalized Float32Array matrix
class VectorIndex {
  private dim = 0
  private data = new Float32Array(0)
  private ids: string[] = []
  private idToRow = new Map<string, number>()
  private qbuf: Float32Array | null = null

  size(): number {
    return this.ids.length
  }

  private ensureCapacity(rows: number, dim: number) {
    if (this.dim === 0) this.dim = dim
    const d = this.dim
    const need = rows * d
    if (need <= this.data.length) return
    let cap = this.data.length || 1024
    while (cap < need) cap *= 2
    const next = new Float32Array(cap)
    next.set(this.data)
    this.data = next
  }

  add(id: string, vec: number[]) {
    const d = this.dim || vec.length
    this.ensureCapacity(this.ids.length + 1, d)
    const row = this.ids.length
    this.ids.push(id)
    this.idToRow.set(id, row)
    const off = row * this.dim
    let sumsq = 0
    for (let i = 0; i < this.dim; i++) {
      const v = vec[i] ?? 0
      this.data[off + i] = v
      sumsq += v * v
    }
    const norm = sumsq > 0 ? 1 / Math.sqrt(sumsq) : 0
    if (norm !== 1 && norm !== 0) {
      for (let i = 0; i < this.dim; i++) this.data[off + i] *= norm
    }
  }

  update(id: string, vec: number[]) {
    const row = this.idToRow.get(id)
    if (row === undefined) {
      this.add(id, vec)
      return
    }
    const off = row * this.dim
    let sumsq = 0
    for (let i = 0; i < this.dim; i++) {
      const v = vec[i] ?? 0
      this.data[off + i] = v
      sumsq += v * v
    }
    const norm = sumsq > 0 ? 1 / Math.sqrt(sumsq) : 0
    if (norm !== 1 && norm !== 0) {
      for (let i = 0; i < this.dim; i++) this.data[off + i] *= norm
    }
  }

  remove(id: string) {
    const row = this.idToRow.get(id)
    if (row === undefined) return
    const last = this.ids.length - 1
    if (row !== last) {
      // swap remove
      this.ids[row] = this.ids[last]
      this.idToRow.set(this.ids[row], row)
      const src = last * this.dim
      const dst = row * this.dim
      this.data.copyWithin(dst, src, src + this.dim)
    }
    this.ids.pop()
    this.idToRow.delete(id)
  }

  topK(queryVec: number[], k: number): Array<{ id: string; s: number }> {
    if (k <= 0 || this.ids.length === 0) return []
    // build normalized query
    const d = this.dim
    if (!this.qbuf || this.qbuf.length !== d) this.qbuf = new Float32Array(d)
    const q = this.qbuf
    let sumsq = 0
    for (let i = 0; i < d; i++) {
      const v = queryVec[i] ?? 0
      q[i] = v
      sumsq += v * v
    }
    const norm = sumsq > 0 ? 1 / Math.sqrt(sumsq) : 0
    if (norm !== 1 && norm !== 0) {
      for (let i = 0; i < d; i++) q[i] *= norm
    }

    const heapIdx: number[] = []
    const heapS: number[] = []
    const push = (idx: number, s: number) => {
      let i = heapIdx.length
      heapIdx.push(idx)
      heapS.push(s)
      while (i > 0) {
        const p = (i - 1) >> 1
        if (heapS[p] <= s) break
        heapIdx[i] = heapIdx[p]
        heapS[i] = heapS[p]
        i = p
      }
      heapIdx[i] = idx
      heapS[i] = s
    }
    const pop = () => {
      const last = heapIdx.length - 1
      heapIdx[0] = heapIdx[last]
      heapS[0] = heapS[last]
      heapIdx.pop()
      heapS.pop()
      let i = 0
      const n = heapIdx.length
      while (true) {
        const l = i * 2 + 1
        const r = l + 1
        if (l >= n) break
        const si = r < n && heapS[r] < heapS[l] ? r : l
        if (heapS[i] <= heapS[si]) break
        const ti = heapIdx[i]
        const ts = heapS[i]
        heapIdx[i] = heapIdx[si]
        heapS[i] = heapS[si]
        heapIdx[si] = ti
        heapS[si] = ts
        i = si
      }
    }

    const rows = this.ids.length
    const data = this.data
    for (let row = 0; row < rows; row++) {
      const off = row * d
      let dot = 0
      let i = 0
      const limit = d - (d % 4)
      // unroll by 4
      for (; i < limit; i += 4) {
        dot += data[off + i] * q[i]
        dot += data[off + i + 1] * q[i + 1]
        dot += data[off + i + 2] * q[i + 2]
        dot += data[off + i + 3] * q[i + 3]
      }
      for (; i < d; i++) dot += data[off + i] * q[i]
      if (heapIdx.length < k) push(row, dot)
      else if (dot > heapS[0]) {
        pop()
        push(row, dot)
      }
    }
    const out = heapIdx.map((ri, i) => ({ id: this.ids[ri], s: heapS[i] }))
    out.sort((a, b) => b.s - a.s)
    return out
  }
}

export class SearchDB {
  private byId = new Map<string, AnnotatedChunk>()
  private bm25 = new BM25Index()
  private vectors = new VectorIndex()

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
    let description: string
    let embedding: number[]
    try {
      const ann = await annotator.labelAndEmbed(chunk)
      description = ann.description
      embedding = ann.embedding
    } catch (err) {
      console.error('Annotation failed for chunk, using defaults:', chunk.id, err)
      description = await defaultLabeler(chunk)
      embedding = await defaultEmbedder(`${description}\n\n${chunk.content}`)
    }

    // Store and update BM25
    this.byId.set(chunk.id, { ...chunk, description, embedding })
    const bm25Text = `${description}\n${chunk.content}`
    this.bm25.add(chunk.id, bm25Text)
    this.vectors.add(chunk.id, embedding)
  }
  async addChunks(chunks: Chunk[]): Promise<void> {
    const batchSize = 10
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const batchNumber = Math.floor(i / batchSize) + 1

      if (batchNumber % 10 === 0) {
        console.log(
          `Processing batch ${batchNumber}/${Math.ceil(chunks.length / batchSize)} (${i + batch.length}/${chunks.length} chunks)`,
        )
      }

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
    this.vectors.remove(id)
  }

  async search(query: string, options: SearchOptions = {}): Promise<AnnotatedChunk[]> {
    const knnK = options.knnK ?? 10
    const bm25K = options.bm25K ?? 10

    // BM25 candidates
    const bm25Pairs = this.bm25.topK(query, bm25K)
    const bm25Candidates = bm25Pairs.map(([id]) => id)

    // KNN candidates
    const annotator = this.opts.annotator || defaultAnnotator
    const qVec = await annotator.embed(query)
    const knnPairs = this.vectors.topK(qVec, knnK)
    const knnCandidates = knnPairs.map((x) => x.id)

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
        console.error('Error in relevance filter', filter)
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
