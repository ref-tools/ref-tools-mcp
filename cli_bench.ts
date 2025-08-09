#!/usr/bin/env tsx
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, spawnSync } from 'node:child_process'
import { chunkCodebase, type Chunk } from './chunker'
import { GraphDB } from './graphdb'
import { SearchDB } from './searchdb'

type RepoSpec = { name: string; url: string }

const REPOS: RepoSpec[] = [
  { name: 'chalk', url: 'https://github.com/chalk/chalk.git' },
  { name: 'axios', url: 'https://github.com/axios/axios.git' },
  { name: 'date-fns', url: 'https://github.com/date-fns/date-fns.git' },
  { name: 'express', url: 'https://github.com/expressjs/express.git' },
]

const BENCH_DIR = path.resolve(process.cwd(), 'bench')
const RESULTS_DIR = path.join(BENCH_DIR, 'results')
const VIEWER_DIR = path.join(BENCH_DIR, 'viewer')
const REPOS_PARENT_DIR = path.resolve(process.cwd(), '..', 'bench_repos')

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true })
}

function run(cmd: string, cwd?: string) {
  execSync(cmd, { stdio: 'inherit', cwd })
}

function nowNs(): bigint {
  return process.hrtime.bigint()
}

function msBetween(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000
}

function median(arr: number[]): number {
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function p95(arr: number[]): number {
  const a = [...arr].sort((x, y) => x - y)
  const idx = Math.max(0, Math.min(a.length - 1, Math.floor(0.95 * (a.length - 1))))
  return a[idx]
}

async function cmdSetup() {
  ensureDir(REPOS_PARENT_DIR)
  console.log(`Using repos directory: ${REPOS_PARENT_DIR}`)
  for (const r of REPOS) {
    const dest = path.join(REPOS_PARENT_DIR, r.name)
    if (fs.existsSync(dest)) {
      console.log(`✓ ${r.name} already present at ${dest}`)
      continue
    }
    console.log(`Cloning ${r.name} -> ${dest}`)
    run(`git clone --depth 1 ${r.url} ${dest}`)
  }
  console.log('Setup complete.')
}

function safeString(v: unknown): string {
  return String(v).replace(/"/g, '\\"')
}

function buildGraphForChunks(db: GraphDB, chunks: Chunk[]) {
  // Build id -> chunk map
  const byId = new Map<string, Chunk>()
  for (const c of chunks) byId.set(c.id, c)

  // Compute root file id for each chunk and group
  const byRootFile = new Map<string, Chunk[]>()
  for (const c of chunks) {
    let cur: Chunk | undefined = c
    let guard = 0
    while (cur && cur.type !== 'file' && guard++ < 1000) {
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    const rootId = cur && cur.type === 'file' ? cur.id : undefined
    if (!rootId) continue
    const arr = byRootFile.get(rootId) || []
    arr.push(c)
    byRootFile.set(rootId, arr)
  }

  // Build CREATE statements per file with variables for each chunk
  for (const [fid, list] of byRootFile.entries()) {
    // map id -> var name
    const vars = new Map<string, string>()
    list.forEach((c, i) => vars.set(c.id, `v${i}`))

    const parts: string[] = []
    for (const c of list) {
      const v = vars.get(c.id)!
      const labels = c.type === 'file' ? ':File' : `:Chunk` // keep simple, all chunks labeled Chunk
      const lineCount = Math.max(1, c.endLine - c.line + 1)
      const props = [
        `id: "${safeString(c.id)}"`,
        `filePath: "${safeString(c.filePath)}"`,
        `language: "${safeString(c.language)}"`,
        `type: "${safeString(c.type)}"`,
        c.name ? `name: "${safeString(c.name)}"` : undefined,
        `line: ${c.line}`,
        `endLine: ${c.endLine}`,
        `lineCount: ${lineCount}`,
      ]
        .filter(Boolean)
        .join(', ')
      parts.push(`(${v}${labels} { ${props} })`)
    }

    // Add CONTAINS relationships according to parent->child relations declared on parent chunk
    for (const parent of list) {
      // Only consider relations stored on the parent chunk to avoid duplicates
      for (const rel of parent.relations || []) {
        if (rel.type !== 'contains') continue
        const vL = vars.get(parent.id)
        const vR = vars.get(rel.targetId)
        // Only add if both ends are present in this group (same root file)
        if (!vL || !vR) continue
        parts.push(`(${vL})-[:CONTAINS]->(${vR})`)
      }
    }

    const cypher = `CREATE ${parts.join(', ')}`
    db.run(cypher)
  }
}

type QueryResult = { label: string; times: number[]; avg: number; median: number; p95: number }

function summarize(times: number[], label: string): QueryResult {
  return {
    label,
    times,
    avg: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
    median: median(times),
    p95: p95(times),
  }
}

async function benchSearchDB(chunks: Chunk[], iterations = 5) {
  const search = new SearchDB()
  const t0 = nowNs()
  await search.addChunks(chunks)
  const t1 = nowNs()
  const indexTimeMs = msBetween(t0, t1)

  const queries: { [name: string]: QueryResult } = {}
  const qdefs: { name: string; q: string }[] = [
    { name: 'q_import', q: 'import module' },
    { name: 'q_class', q: 'class method' },
    { name: 'q_http', q: 'http request response' },
  ]
  for (const { name, q } of qdefs) {
    const times: number[] = []
    for (let i = 0; i < iterations; i++) {
      const s = nowNs()
      // eslint-disable-next-line no-await-in-loop
      await search.search(q)
      const e = nowNs()
      times.push(msBetween(s, e))
    }
    queries[name] = summarize(times, q)
  }
  return { indexTimeMs, queries }
}

async function benchGraphDB(chunks: Chunk[], iterations = 5) {
  const graph = new GraphDB()
  const g0 = nowNs()
  buildGraphForChunks(graph, chunks)
  const g1 = nowNs()
  const buildTimeMs = msBetween(g0, g1)

  const queries: { [name: string]: QueryResult } = {}
  const statements: { name: string; cypher: string }[] = [
    { name: 'count_files', cypher: 'MATCH (f:File) RETURN count(f) AS count' },
    { name: 'count_chunks', cypher: 'MATCH (c:Chunk) RETURN count(c) AS count' },
    { name: 'contains_edges', cypher: 'MATCH (a:File)-[:CONTAINS]->(b:Chunk) RETURN count(b) AS count' },
    { name: 'large_chunks', cypher: 'MATCH (c:Chunk) WHERE c.lineCount >= 50 RETURN count(c) AS count' },
  ]
  for (const { name, cypher } of statements) {
    const times: number[] = []
    for (let i = 0; i < iterations; i++) {
      const s = nowNs()
      graph.run(cypher)
      const e = nowNs()
      times.push(msBetween(s, e))
    }
    queries[name] = summarize(times, cypher)
  }
  return { buildTimeMs, queries }
}

async function cmdRun() {
  const iterations = Number(process.env.BENCH_ITERS || '5')
  ensureDir(RESULTS_DIR)
  const reposToUse = REPOS
  const runId = `run-${Date.now()}`
  const startedAt = new Date().toISOString()
  const results: any = {
    runId,
    startedAt,
    iterations,
    system: {
      node: process.version,
      platform: process.platform,
      cpus: os.cpus()?.length || 0,
    },
    repos: [] as any[],
  }
  for (const r of reposToUse) {
    const repoPath = path.join(REPOS_PARENT_DIR, r.name)
    if (!fs.existsSync(repoPath)) {
      console.warn(`Repo not found: ${repoPath}. Run: npm run bench:setup`)
      continue
    }
    console.log(`Chunking ${r.name} ...`)
    const c0 = nowNs()
    const chunks = await chunkCodebase(repoPath)
    const c1 = nowNs()
    const chunkTimeMs = msBetween(c0, c1)
    const numFiles = chunks.filter((c) => c.type === 'file').length
    const numChunks = chunks.length
    console.log(` - ${numFiles} files -> ${numChunks} chunks (${chunkTimeMs.toFixed(1)} ms)`)

    console.log(`SearchDB bench for ${r.name} ...`)
    const sres = await benchSearchDB(chunks, iterations)

    console.log(`GraphDB bench for ${r.name} ...`)
    const gres = await benchGraphDB(chunks, iterations)

    results.repos.push({
      name: r.name,
      path: repoPath,
      numFiles,
      numChunks,
      chunkTimeMs,
      searchdb: sres,
      graphdb: gres,
    })
  }

  const outPath = path.join(RESULTS_DIR, `${runId}.json`)
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`Wrote results: ${path.relative(process.cwd(), outPath)}`)

  // Update index.json summary
  const indexPath = path.join(RESULTS_DIR, 'index.json')
  let index: any[] = []
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    } catch {}
  }
  const summary = {
    runId: results.runId,
    startedAt: results.startedAt,
    iterations: results.iterations,
    repos: results.repos.map((x: any) => ({
      name: x.name,
      numChunks: x.numChunks,
      searchdb_index_ms: x.searchdb.indexTimeMs,
      graphdb_build_ms: x.graphdb.buildTimeMs,
    })),
  }
  index.push(summary)
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))
  console.log(`Updated index: ${path.relative(process.cwd(), indexPath)}`)

  // Ensure viewer exists
  await cmdViz('quiet')
}

async function cmdViz(mode?: 'quiet') {
  ensureDir(VIEWER_DIR)
  const htmlPath = path.join(VIEWER_DIR, 'index.html')
  if (!fs.existsSync(htmlPath)) {
    fs.writeFileSync(htmlPath, VIEWER_HTML)
  }
  if (mode !== 'quiet') {
    console.log(`Open viewer: ${htmlPath}`)
    // Try to open in default browser if possible
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    const res = spawnSync(opener, [htmlPath], { stdio: 'ignore' })
    if (res.error) {
      console.log('Could not auto-open browser. Please open the path above manually.')
    }
  }
}

const VIEWER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bench Results</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin: 0; padding: 24px; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      .row { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
      .card { border: 1px solid rgba(127,127,127,.3); border-radius: 12px; padding: 16px; min-width: 320px; }
      .muted { color: #888; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(127,127,127,.2); }
      .bar { height: 10px; background: linear-gradient(90deg, #6ee7b7, #3b82f6); border-radius: 6px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
      code { background: rgba(127,127,127,.12); padding: 1px 4px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>GraphDB vs SearchDB — Benchmarks</h1>
    <div class="muted">Polls results/index.json every 2s. Drop new runs to update.</div>
    <div id="content"></div>
    <script>
      async function fetchJSON(p) { try { const r = await fetch(p + '?_=' + Date.now()); if (!r.ok) return null; return r.json(); } catch { return null } }
      function fmt(n){ return typeof n==='number'? n.toFixed(1): n }
      function renderIndex(idx){
        const container = document.getElementById('content');
        if (!idx || !idx.length) { container.innerHTML = '<p>No runs yet. Run <code>npm run bench:run</code>.</p>'; return }
        const last = idx[idx.length-1]
        let html = ''
        html += '<div class="row">'
        html += '<div class="card"><div class="muted">Latest run</div>'
        html += '<div><b>' + last.runId + '</b></div>'
        html += '<div class="muted">' + last.startedAt + ' • iters: ' + last.iterations + '</div>'
        html += '</div>'
        html += '</div>'
        html += '<div class="row">'
        for (const r of last.repos) {
          const maxBuild = Math.max(r.searchdb_index_ms||0, r.graphdb_build_ms||0, 1)
          html += '<div class="card" style="flex:1">'
          html += '<div style="font-weight:600;margin-bottom:6px">' + r.name + '</div>'
          html += '<div class="muted" style="margin-bottom:8px">chunks: ' + r.numChunks + '</div>'
          html += '<div class="grid">'
          html += '<div>SearchDB index: '+ fmt(r.searchdb_index_ms) +' ms<div class="bar" style="width:'+(r.searchdb_index_ms/maxBuild*100)+'%"></div></div>'
          html += '<div>GraphDB build: '+ fmt(r.graphdb_build_ms) +' ms<div class="bar" style="width:'+(r.graphdb_build_ms/maxBuild*100)+'%"></div></div>'
          html += '</div>'
          html += '</div>'
        }
        html += '</div>'
        html += '<div class="muted" style="margin-top:12px">See full run files under bench/results/ for per-query stats.</div>'
        container.innerHTML = html
      }
      async function tick(){
        const idx = await fetchJSON('../results/index.json')
        renderIndex(idx)
      }
      tick(); setInterval(tick, 2000)
    </script>
  </body>
  </html>`

async function main() {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'setup':
      await cmdSetup()
      break
    case 'run':
      await cmdRun()
      break
    case 'viz':
      await cmdViz()
      break
    default:
      console.log('Usage: tsx cli_bench.ts <setup|run|viz>')
      console.log('Env: BENCH_ITERS=5')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
