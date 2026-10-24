// Smoke test for the built server (dist/index.cjs).
// Starts it over stdio and over HTTP, checks /ping, then calls
// ref_search_documentation and ref_read_url through the MCP SDK client.
// Usage: REF_API_KEY=... npm run smoke
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { resolve } from 'path'

const SERVER = resolve('dist/index.cjs')
const QUERY = process.env.SMOKE_QUERY || 'MCP TypeScript SDK StreamableHTTPClientTransport'
const READ_URL =
  process.env.SMOKE_READ_URL || 'https://modelcontextprotocol.io/docs/getting-started/intro'
const PORT = parseInt(process.env.SMOKE_PORT || '8787', 10)

// The server reports API failures as normal text content, so match them here.
const ERROR_TEXT = [
  'Error during documentation search',
  'Error reading URL',
  'Please verify your email',
  'Ref is not correctly configured',
]

type TextContent = { type: string; text?: string }

function texts(result: unknown): string[] {
  const content = ((result as { content?: TextContent[] }).content || []) as TextContent[]
  return content.filter((c) => c.type === 'text').map((c) => c.text || '')
}

function assertNoError(tool: string, parts: string[]) {
  const failed = parts.find((t) => ERROR_TEXT.some((e) => t.startsWith(e)))
  if (failed) throw new Error(`${tool} returned an error: ${failed}`)
}

async function exercise(label: string, client: Client) {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  console.log(`[${label}] tools: ${names.join(', ')}`)

  const errors: string[] = []
  let readUrl = READ_URL

  try {
    const search = texts(
      await client.callTool({ name: 'ref_search_documentation', arguments: { query: QUERY } }),
    )
    assertNoError('ref_search_documentation', search)
    const urls = search.map((t) => /^url: (.*)$/m.exec(t)?.[1]).filter((u): u is string => !!u)
    if (urls.length === 0)
      throw new Error(`ref_search_documentation returned no urls: ${search[0]}`)
    readUrl = urls[0]!
    console.log(`[${label}] ref_search_documentation: ${search.length} results, first: ${readUrl}`)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  // Read the first search result, or READ_URL if search failed, so both tools always run.
  try {
    const read = texts(await client.callTool({ name: 'ref_read_url', arguments: { url: readUrl } }))
    assertNoError('ref_read_url', read)
    const body = read.join('\n')
    if (!body.trim()) throw new Error('ref_read_url returned empty content')
    const firstLine = body.split('\n').find((l) => l.trim()) || ''
    const sha = createHash('sha256').update(body).digest('hex').slice(0, 12)
    console.log(
      `[${label}] ref_read_url: ${body.length} chars, sha256 ${sha}, first line: ${firstLine.slice(0, 80)}`,
    )
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  if (errors.length > 0) throw new Error(errors.join('; '))
}

async function smokeStdio() {
  const client = new Client({ name: 'ref-smoke', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...(process.env as Record<string, string>), TRANSPORT: 'stdio' },
    stderr: 'ignore',
  })
  await client.connect(transport)
  try {
    await exercise('stdio', client)
  } finally {
    await client.close()
  }
}

async function waitForPing(base: string) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/ping`)
      const text = await res.text()
      if (res.status === 200 && text === 'pong') return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${base}/ping never returned 200 pong`)
}

async function smokeHttp() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TRANSPORT: 'http', PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const base = `http://localhost:${PORT}`
  try {
    await waitForPing(base)
    console.log('[http] GET /ping: 200 pong')
    const client = new Client({ name: 'ref-smoke', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
    try {
      await exercise('http', client)
    } finally {
      await client.close()
    }
  } finally {
    child.kill()
  }
}

async function main() {
  if (!existsSync(SERVER)) throw new Error(`${SERVER} not found; run npm run build first`)
  if (!process.env.REF_API_KEY) throw new Error('REF_API_KEY is not set')
  const failures: string[] = []
  for (const [label, run] of [
    ['stdio', smokeStdio],
    ['http', smokeHttp],
  ] as const) {
    try {
      await run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[${label}] FAILED: ${message}`)
      failures.push(label)
    }
  }
  if (failures.length > 0) throw new Error(`failed transports: ${failures.join(', ')}`)
  console.log('smoke: OK')
}

main().catch((error) => {
  console.error('smoke: FAILED', error instanceof Error ? error.message : error)
  process.exit(1)
})
