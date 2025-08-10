#!/usr/bin/env tsx
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import { chunkCodebase, type Chunk } from './chunker'
import { GraphDB } from './graphdb'
import { SearchDB } from './searchdb'
import { makeOpenAIAnnotator } from './openai_searchdb'
import { pickChunksFilter } from './pickdocs'

type RepoSpec = { name: string; url: string }

const REPOS: RepoSpec[] = [
  { name: 'chalk', url: 'https://github.com/chalk/chalk.git' },
  { name: 'axios', url: 'https://github.com/axios/axios.git' },
  { name: 'date-fns', url: 'https://github.com/date-fns/date-fns.git' },
  { name: 'express', url: 'https://github.com/expressjs/express.git' },
  // Larger real-world app (~10k+ files) to stress test chunking and indexing
  { name: 'vscode', url: 'https://github.com/microsoft/vscode.git' },
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
  if (arr.length === 0) return 0
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0
  const a = [...arr].sort((x, y) => x - y)
  const idx = Math.max(0, Math.min(a.length - 1, Math.floor(0.95 * (a.length - 1))))
  return a[idx]!
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
  for (const [, list] of byRootFile.entries()) {
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

type QueryResult = {
  label: string
  times: number[]
  mean: number
  median: number
  p95: number
  stdev: number
  sem: number
  ci95: number
  min: number
  max: number
}

function summarize(times: number[], label: string): QueryResult {
  const n = Math.max(1, times.length)
  const mean = times.reduce((a, b) => a + b, 0) / n
  const variance =
    times.reduce((acc, t) => acc + Math.pow(t - mean, 2), 0) /
    (times.length > 1 ? times.length - 1 : 1)
  const stdev = Math.sqrt(variance)
  const sem = stdev / Math.sqrt(n)
  const ci95 = 1.96 * sem
  const min = Math.min(...times)
  const max = Math.max(...times)
  return { label, times, mean, median: median(times), p95: p95(times), stdev, sem, ci95, min, max }
}

function queriesForRepo(repo: string): string[] {
  // 10 realistic text queries per repo for SearchDB
  switch (repo) {
    case 'chalk':
      return [
        'ansi color styles',
        'rgb hex color',
        'bold underline',
        'chalk instance factory',
        'template literal tag',
        'supportsColor level',
        'strip ansi escape',
        'tty detection',
        'typescript types',
        'browser build',
      ]
    case 'axios':
      return [
        'request interceptor',
        'response interceptor',
        'cancel token abort',
        'xhr adapter',
        'http proxy agent',
        'timeout error',
        'transform request',
        'default headers',
        'form data',
        'baseURL config',
      ]
    case 'express':
      return [
        'middleware next function',
        'router param',
        'static file serve',
        'req res object',
        'app listen port',
        'error handler',
        'json body parser',
        'template engine',
        'cookie parser',
        'route path',
      ]
    case 'date-fns':
    case 'datefns':
    case 'date_fns':
      return [
        'format date',
        'parse ISO',
        'add days',
        'difference in days',
        'start of week',
        'end of month',
        'is valid',
        'compare asc',
        'each day of interval',
        'locale enUS',
      ]
    default:
      return [
        'init function',
        'config options',
        'error handling',
        'http client',
        'plugin system',
        'typescript types',
        'class constructor',
        'utility helpers',
        'parser',
        'encoder',
      ]
  }
}

async function benchSearchDB(repoName: string, chunks: Chunk[], iterations = 5) {
  const search = new SearchDB({
    annotator: makeOpenAIAnnotator({
      apiKey: process.env.OPENAI_API_KEY!,
      labelModel: 'gpt-5-nano',
      embedModel: 'text-embedding-3-small',
    }),
    relevanceFilter: pickChunksFilter,
  })
  const t0 = nowNs()
  await search.addChunks(chunks)
  const t1 = nowNs()
  const indexTimeMs = msBetween(t0, t1)

  const queries: { [name: string]: QueryResult } = {}
  const qlist = queriesForRepo(repoName)
  qlist.forEach(
    (q, i) =>
      (queries[`q${i + 1}`] = {
        label: q,
        times: [],
        mean: 0,
        median: 0,
        p95: 0,
        stdev: 0,
        sem: 0,
        ci95: 0,
        min: 0,
        max: 0,
      }),
  )
  for (const [name, meta] of Object.entries(queries)) {
    const times: number[] = []
    for (let i = 0; i < iterations; i++) {
      const s = nowNs()
      // eslint-disable-next-line no-await-in-loop
      await search.search(meta.label)
      const e = nowNs()
      times.push(msBetween(s, e))
    }
    queries[name] = summarize(times, meta.label)
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
    {
      name: 'contains_edges',
      cypher: 'MATCH (a:File)-[:CONTAINS]->(b:Chunk) RETURN count(b) AS count',
    },
    {
      name: 'large_chunks_50',
      cypher: 'MATCH (c:Chunk) WHERE c.lineCount >= 50 RETURN count(c) AS count',
    },
    {
      name: 'large_chunks_200',
      cypher: 'MATCH (c:Chunk) WHERE c.lineCount >= 200 RETURN count(c) AS count',
    },
    {
      name: 'js_chunks',
      cypher: "MATCH (c:Chunk) WHERE c.language = 'javascript' RETURN count(c) AS count",
    },
    {
      name: 'ts_chunks',
      cypher: "MATCH (c:Chunk) WHERE c.language = 'typescript' RETURN count(c) AS count",
    },
    {
      name: 'tsx_chunks',
      cypher: "MATCH (c:Chunk) WHERE c.language = 'tsx' RETURN count(c) AS count",
    },
    {
      name: 'classes',
      cypher: "MATCH (c:Chunk) WHERE c.type = 'class_declaration' RETURN count(c) AS count",
    },
    {
      name: 'methods',
      cypher: "MATCH (c:Chunk) WHERE c.type = 'method_definition' RETURN count(c) AS count",
    },
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
    const sres = await benchSearchDB(r.name, chunks, iterations)

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
  // Always overwrite to pick up UI updates
  fs.writeFileSync(htmlPath, VIEWER_HTML)

  // In quiet mode (used by run), just ensure files exist and return.
  if (mode === 'quiet') return

  // Start a minimal static server rooted at BENCH_DIR so the viewer can fetch JSON over HTTP.
  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://localhost')
      const pathname = decodeURIComponent(reqUrl.pathname)
      let fsPath = path.join(BENCH_DIR, pathname)
      const resolved = path.resolve(fsPath)
      if (!resolved.startsWith(BENCH_DIR)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        fsPath = path.join(resolved, 'index.html')
      } else {
        fsPath = resolved
      }
      if (!fs.existsSync(fsPath)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const ext = path.extname(fsPath).toLowerCase()
      const mime =
        ext === '.html'
          ? 'text/html; charset=utf-8'
          : ext === '.json'
            ? 'application/json; charset=utf-8'
            : ext === '.js'
              ? 'text/javascript; charset=utf-8'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      fs.createReadStream(fsPath).pipe(res)
    } catch (e) {
      res.writeHead(500)
      res.end('Server error')
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr && 'port' in addr ? (addr as any).port : 0
  const url = `http://localhost:${port}/viewer/index.html`
  console.log(`Serving bench at http://localhost:${port}/`)
  console.log(`Open viewer: ${url}`)

  // Try to open in default browser if possible
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const res = spawnSync(opener, [url], { stdio: 'ignore' })
  if ((res as any).error) {
    console.log('Could not auto-open browser. Please open the URL above manually.')
  }
}

const VIEWER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bench: Latency vs Repo Size</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin: 0; padding: 20px; }
      h1 { font-size: 18px; margin: 0 0 10px; }
      .muted { color: #888; font-size: 12px; margin-bottom: 10px; }
      .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
      select { padding: 4px 8px; font-size: 13px; }
      #legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .chip { display:inline-flex; align-items:center; gap:6px; padding: 2px 6px; border-radius: 999px; font-size: 12px; border:1px solid rgba(127,127,127,.3) }
      .dot { width:10px; height:10px; border-radius: 50%; display:inline-block }
      svg { width: 100%; max-width: 1000px; height: 520px; background: rgba(127,127,127,.06); border-radius: 8px; }
      .axis text { font-size: 11px; fill: currentColor; }
      .axis line, .axis path { stroke: rgba(127,127,127,.6); stroke-width: 1; shape-rendering: crispEdges; }
    </style>
  </head>
  <body>
    <h1>Latency vs Repo Size</h1>
    <div class="muted">One line per query type. X: repo chunks, Y: mean latency (ms).</div>
    <div class="controls">
      <label>Dataset
        <select id="dataset">
          <option value="searchdb">SearchDB</option>
          <option value="graphdb">GraphDB</option>
        </select>
      </label>
      <div id="runMeta" class="muted"></div>
    </div>
    <svg id="chart" viewBox="0 0 1000 520"></svg>
    <div id="legend"></div>
    <script>
      async function fetchJSON(p) { try { const r = await fetch(p + '?_=' + Date.now()); if (!r.ok) return null; return r.json(); } catch { return null } }
      function fmt(n){ return typeof n==='number'? n.toFixed(1): n }
      const COLORS = ['#2563eb','#16a34a','#dc2626','#7c3aed','#db2777','#059669','#f59e0b','#0ea5e9','#a855f7','#ef4444']

      function buildSeries(run, dataset){
        const repos = (run?.repos||[]).slice().sort((a,b)=> (a.numChunks||0) - (b.numChunks||0))
        const series = {} // label -> [{x,y, repo}]
        for (const r of repos){
          const q = (r[dataset]||{}).queries || {}
          for (const [key, v] of Object.entries(q)){
            const label = dataset==='graphdb' ? key : (v.label || key)
            if (!series[label]) series[label] = []
            series[label].push({ x: r.numChunks||0, y: (v.mean||0), repo: r.name })
          }
        }
        return series
      }

      function renderChart(series){
        const svg = document.getElementById('chart')
        const W = 1000, H = 520, PADL = 60, PADB = 40, PADT = 10, PADR = 10
        const innerW = W - PADL - PADR, innerH = H - PADT - PADB
        svg.innerHTML = ''
        const allX = [], allY = []
        for (const pts of Object.values(series)){
          for (const p of pts){ allX.push(p.x); allY.push(p.y) }
        }
        const xMin = 0, xMax = Math.max(1, Math.max(...allX, 1))
        const yMin = 0, yMax = Math.max(1, Math.max(...allY, 1))
        const sx = (x)=> PADL + (x - xMin) / (xMax - xMin) * innerW
        const sy = (y)=> H - PADB - (y - yMin) / (yMax - yMin) * innerH

        const ns = 'http://www.w3.org/2000/svg'
        function line(x1,y1,x2,y2,cls){ const el = document.createElementNS(ns,'line'); el.setAttribute('x1',x1); el.setAttribute('y1',y1); el.setAttribute('x2',x2); el.setAttribute('y2',y2); if (cls) el.setAttribute('class',cls); return el }
        function text(x,y,t,anchor='middle'){ const el=document.createElementNS(ns,'text'); el.setAttribute('x',x); el.setAttribute('y',y); el.setAttribute('text-anchor',anchor); el.textContent=t; return el }
        function path(d, color){ const el=document.createElementNS(ns,'path'); el.setAttribute('d',d); el.setAttribute('fill','none'); el.setAttribute('stroke',color); el.setAttribute('stroke-width','2'); return el }
        function circle(x,y,color){ const el=document.createElementNS(ns,'circle'); el.setAttribute('cx',x); el.setAttribute('cy',y); el.setAttribute('r','3'); el.setAttribute('fill',color); return el }

        // Axes
        const gAxes = document.createElementNS(ns,'g'); gAxes.setAttribute('class','axis')
        gAxes.appendChild(line(PADL, PADT, PADL, H-PADB))
        gAxes.appendChild(line(PADL, H-PADB, W-PADR, H-PADB))
        // Ticks
        const xTicks = 5, yTicks = 5
        for (let i=0;i<=xTicks;i++){
          const t = xMin + i*(xMax-xMin)/xTicks
          const X = sx(t); gAxes.appendChild(line(X, H-PADB, X, H-PADB+6))
          const tx = text(X, H-PADB+18, String(Math.round(t))) ; gAxes.appendChild(tx)
        }
        for (let i=0;i<=yTicks;i++){
          const t = yMin + i*(yMax-yMin)/yTicks
          const Y = sy(t); gAxes.appendChild(line(PADL-6, Y, PADL, Y))
          const ty = text(PADL-10, Y+4, String(Math.round(t)), 'end'); gAxes.appendChild(ty)
        }
        svg.appendChild(gAxes)

        // Series
        const labels = Object.keys(series)
        labels.sort()
        const legend = document.getElementById('legend'); legend.innerHTML = ''
        labels.forEach((label, i)=>{
          const color = COLORS[i % COLORS.length]
          const pts = series[label].slice().sort((a,b)=>a.x-b.x)
          if (!pts.length) return
          let d = ''
          for (let j=0;j<pts.length;j++){
            const X = sx(pts[j].x), Y = sy(pts[j].y)
            d += (j===0? 'M':' L') + X + ' ' + Y
          }
          svg.appendChild(path(d, color))
          for (const p of pts){ svg.appendChild(circle(sx(p.x), sy(p.y), color)) }
          const chip = document.createElement('div'); chip.className='chip'; chip.innerHTML = '<span class="dot" style="background:'+color+'"></span><span>'+label+'</span>'
          legend.appendChild(chip)
        })
      }

      async function render(){
        const idx = await fetchJSON('../results/index.json')
        const metaEl = document.getElementById('runMeta');
        if (!idx || !idx.length) { metaEl.textContent = 'No runs yet. Run npm run bench:run'; return }
        const last = idx[idx.length-1]
        metaEl.textContent = last.runId + ' • ' + last.startedAt + ' • iters: ' + last.iterations
        const run = await fetchJSON('../results/' + last.runId + '.json')
        const dataset = document.getElementById('dataset').value
        const series = buildSeries(run, dataset)
        renderChart(series)
      }
      document.getElementById('dataset').addEventListener('change', render)
      render(); setInterval(render, 5000)
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
