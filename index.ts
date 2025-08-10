/**
 * @fileoverview Ref MCP server with documentation search and URL reading tools.
 * Supports stdio and HTTP transports with dynamic configuration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  isInitializeRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import axios from 'axios'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { callUiHello } from './helloui.js'
import { callGenerateUi } from './genui.js'
import { visualizeCodeTool, callVisualizeCode } from './visualize_code.js'
import SearchAgent, { SEARCH_GRAPH_DESCRIPTION, SEARCH_QUERY_DESCRIPTION } from './search_agent.js'
import { makeOpenAIAnnotator } from './openai_searchdb.js'
import { pickChunksFilter } from './pickdocs.js'

// Tool configuration based on client type
type ToolConfig = {
  searchToolName: string
  readToolName: string
}

const OPENAI_DEEP_RESEARCH_TOOL_CONFIG: ToolConfig = {
  searchToolName: 'search',
  readToolName: 'fetch',
}

const DEFAULT_TOOL_CONFIG: ToolConfig = {
  searchToolName: 'ref_search_documentation',
  readToolName: 'ref_read_url',
}

// Transport configuration from environment
const TRANSPORT_TYPE = (process.env.TRANSPORT || 'stdio') as 'stdio' | 'http'
const HTTP_PORT = parseInt(process.env.PORT || '8080', 10)

// Global variables to store current request config
let currentApiKey: string | undefined = undefined
// Optional code search agent (gated by env)
let codeSearchAgent: SearchAgent | undefined

// Session management for HTTP transport
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}
const sessionClientInfo: { [sessionId: string]: string } = {}
const servers: { [sessionId: string]: Server } = {}

// DeepResearch shape for OpenAI compatibility
type DeepResearchShape = {
  id: string
  title: string
  text: string
  url: string
  metadata?: any
}

// Function to create a new server instance
function createServerInstance(mcpClient: string = 'unknown', sessionId?: string) {
  const toolConfig =
    mcpClient === 'openai-mcp' ? OPENAI_DEEP_RESEARCH_TOOL_CONFIG : DEFAULT_TOOL_CONFIG

  const searchTool: Tool = {
    name: toolConfig.searchToolName,
    description: `Search for documentation on the web or github as well from private resources like repos and pdfs. Use Ref '${toolConfig.readToolName}' to read the content of a url.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: `Query for documentation. Should include programming language and framework or library names. Searches public only docs by default, include ref_src=private to search a user's private docs.`,
        },
      },
      required: ['query'],
    },
  }

  const readTool: Tool = {
    name: toolConfig.readToolName,
    description: `Read the content of a url as markdown. The entire exact URL from a Ref '${toolConfig.searchToolName}' result should be passed to this tool to read it.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to read.',
        },
      },
      required: ['url'],
    },
  }

  const server = new Server(
    {
      name: 'Ref',
      version: '3.0.0',
    },
    {
      capabilities: {
        prompts: {
          listChanged: true,
        },
        tools: {},
        logging: {},
      },
    },
  )

  // Register request handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      searchTool,
      readTool,
      // Conditionally expose local code search tools when configured (env-gated)
      ...(process.env.REF_DIRECTORY && process.env.OPENAI_API_KEY
        ? ([
            {
              name: 'search_code_text',
              description: SEARCH_QUERY_DESCRIPTION,
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Natural language query' } },
                required: ['query'],
              },
            },
            {
              name: 'search_code_graph',
              description: SEARCH_GRAPH_DESCRIPTION,
              inputSchema: {
                type: 'object',
                properties: { cypher: { type: 'string', description: 'Cypher query' } },
                required: ['cypher'],
              },
            },
          ] as any)
        : ([] as any)),
      // uiHelloTool,
      // generateUiTool,
      visualizeCodeTool,
    ],
  }))

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'search_docs',
        description:
          'A quick way to check technical documentation. This prompt helps you search documentation for any technical platform, framework, API, service, database, or library.',
        arguments: [
          {
            name: 'query',
            description: 'The rest of your prompt or question you want informed by docs',
            required: true,
          },
        ],
      },
      {
        name: 'my_docs',
        description:
          "Search through your private documentation, repos, and PDFs that you've uploaded to Ref.",
        arguments: [
          {
            name: 'query',
            description:
              'The rest of your prompt or question you want informed by your private docs',
            required: true,
          },
        ],
      },
    ],
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (name === 'search_docs') {
      const query = args?.query as string
      if (!query) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: query')
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${query}\n\nSearch ref with source=public`,
            },
          },
        ],
      }
    }

    if (name === 'my_docs') {
      const query = args?.query as string
      if (!query) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: query')
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${query}\n\nSearch ref with source=private`,
            },
          },
        ],
      }
    }

    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`)
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === toolConfig.searchToolName) {
      console.error('[search_documentation] arguments', request.params.arguments)
      const input = request.params.arguments as {
        query: string
      }
      return doSearch(input.query, mcpClient, sessionId)
    }

    if (request.params.name === 'search_code_text') {
      if (!codeSearchAgent) {
        return {
          content: [
            {
              type: 'text',
              text: 'Local code search is not configured. Set REF_DIRECTORY and OPENAI_API_KEY.',
            },
          ],
        }
      }
      const input = request.params.arguments as { query: string }
      if (!input?.query) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: query')
      }
      const out = await codeSearchAgent.searchQueryAsTextItems(input.query)
      return { content: out as any }
    }

    if (request.params.name === 'search_code_graph') {
      if (!codeSearchAgent) {
        return {
          content: [
            {
              type: 'text',
              text: 'Local code graph search is not configured. Set REF_DIRECTORY and OPENAI_API_KEY.',
            },
          ],
        }
      }
      const input = request.params.arguments as { cypher: string }
      if (!input?.cypher) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: cypher')
      }
      const out = codeSearchAgent.searchGraphAsTextItems(input.cypher)
      return { content: out as any }
    }

    if (request.params.name === toolConfig.readToolName) {
      const input = request.params.arguments as { url: string }
      return doRead(input.url, mcpClient, sessionId)
    }

    if (request.params.name === 'ui_hello') {
      return callUiHello()
    }

    if (request.params.name === 'generate_ui') {
      const args = (request.params.arguments || {}) as {
        message: string
        title?: string
        theme?: string
      }
      if (!args.message) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: message')
      }
      return callGenerateUi(args)
    }

    if (request.params.name === 'visualize_code') {
      const args = (request.params.arguments || {}) as {
        message: string
        title?: string
      }
      if (!args.message) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: message')
      }
      // Try to include an up-to-date graph snapshot if local code agent is initialized
      let graph: any = undefined
      try {
        // Access internal graph reference like other code tools do
        const g = (codeSearchAgent as any)?.['graph']
        graph = typeof g?.getGraph === 'function' ? g.getGraph() : undefined
      } catch {}
      return callVisualizeCode({ message: args.message, title: args.title, graph })
    }

    throw new McpError(ErrorCode.MethodNotFound, `Could not find tool: ${request.params.name}`)
  })

  server.onerror = (error: any) => {
    console.error(error)
  }

  return server
}

const getRefUrl = () => {
  if (process.env.REF_URL) {
    return process.env.REF_URL
  }
  return 'https://api.ref.tools'
}

// Helper function to get API key from environment or current request
const getApiKey = () => {
  return process.env.REF_ALPHA || process.env.REF_API_KEY || currentApiKey
}

// Helper function to get auth headers with session support
const getAuthHeaders = (sessionId?: string) => {
  const headers: Record<string, string | undefined> = {
    'X-Ref-Alpha':
      process.env.REF_ALPHA ||
      (currentApiKey && !process.env.REF_API_KEY ? currentApiKey : undefined),
    'X-Ref-Api-Key':
      process.env.REF_API_KEY ||
      (currentApiKey && !process.env.REF_ALPHA ? currentApiKey : undefined),
  }

  if (sessionId) {
    headers['mcp-session-id'] = sessionId
  }

  return headers
}

function toDeepResearchShape(doc: any): DeepResearchShape {
  return {
    id: doc.url,
    title: doc.overview || doc.title || '',
    text: (doc.content || '').slice(0, 100),
    url: doc.url,
    metadata: {
      moduleId: doc.moduleId,
    },
  }
}

async function doSearch(query: string, mcpClient: string = 'unknown', sessionId?: string) {
  const url = getRefUrl() + '/search_documentation?query=' + encodeURIComponent(query)
  console.error('[search]', url)

  if (!getApiKey()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Ref is not correctly configured. Reach out to hello@ref.tools for help.',
        },
      ],
    }
  }

  try {
    const response = await axios.get(url, {
      headers: getAuthHeaders(sessionId),
    })
    const data = response.data

    if (data.docs.length === 0) {
      return {
        content: [{ type: 'text', text: 'No results found' }],
      }
    }

    // Return different formats based on client type
    if (mcpClient === 'openai-mcp') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data.docs.map(toDeepResearchShape)),
          },
        ],
      }
    } else {
      return {
        content: data.docs.map((doc: any) => ({
          type: 'text' as const,
          text: `overview: ${doc.overview || ''}
url: ${doc.url}
moduleId: ${doc.moduleId || ''}`,
        })),
      }
    }
  } catch (error) {
    console.error('[search-error]', error)
    return {
      content: [
        {
          type: 'text',
          text: `Error during documentation search: ${axios.isAxiosError(error) ? error.message : (error as Error).message}`,
        },
      ],
    }
  }
}

async function doRead(url: string, mcpClient: string = 'unknown', sessionId?: string) {
  try {
    const readUrl = getRefUrl() + '/read?url=' + encodeURIComponent(url)
    console.error('[read]', readUrl)

    if (!getApiKey()) {
      return {
        content: [
          {
            type: 'text',
            text: 'Ref is not correctly configured. Reach out to hello@ref.tools for help.',
          },
        ],
      }
    }

    const response = await axios.get(readUrl, {
      headers: getAuthHeaders(sessionId),
    })

    const data = response.data

    // Return different formats based on client type
    if (mcpClient === 'openai-mcp') {
      const result: DeepResearchShape = {
        id: url,
        title: data.title || '',
        text: data.content || '',
        url,
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      }
    } else {
      return {
        content: [{ type: 'text', text: data.content || '' }],
      }
    }
  } catch (error) {
    console.error('[read-error]', error)
    return {
      content: [
        {
          type: 'text',
          text: `Error reading URL: ${axios.isAxiosError(error) ? error.message : (error as Error).message}`,
        },
      ],
    }
  }
}

async function main() {
  const transportType = TRANSPORT_TYPE

  if (transportType === 'http') {
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`).pathname

      // Set CORS headers for all responses
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Session-Id, mcp-session-id')

      // Handle preflight OPTIONS requests
      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      try {
        if (url === '/mcp') {
          // Extract client info
          const userAgentHeader =
            req.headers['user-agent'] || req.headers['x-mcp-client'] || req.headers['mcp-client']
          const userAgent: string = Array.isArray(userAgentHeader)
            ? userAgentHeader[0] || 'unknown'
            : userAgentHeader || 'unknown'

          // Get body for POST requests
          let body: any = {}
          if (req.method === 'POST') {
            const chunks: Buffer[] = []
            for await (const chunk of req) {
              chunks.push(chunk)
            }
            const bodyString = Buffer.concat(chunks).toString()
            try {
              body = JSON.parse(bodyString)
            } catch (e) {
              // Ignore parse errors
            }
          }

          const sessionId = req.headers['mcp-session-id'] as string | undefined
          const mcpClient: string =
            (sessionId && sessionClientInfo[sessionId]) ||
            body?.params?.clientInfo?.name ||
            userAgent.split('/')[0] ||
            'unknown'

          console.error('MCP REQUEST', {
            headers: req.headers,
            method: req.method,
            url: req.url,
            sessionId,
            mcpClient,
          })

          // Extract config from base64-encoded JSON parameter for Smithery compatibility
          const fullUrl = new URL(req.url || '', `http://${req.headers.host}`)
          const configParam = fullUrl.searchParams.get('config')

          if (configParam) {
            try {
              const decodedConfig = Buffer.from(configParam, 'base64').toString('utf-8')
              const config = JSON.parse(decodedConfig)

              if (config.refApiKey) {
                currentApiKey = config.refApiKey
              }
            } catch (error) {
              console.error('Failed to parse config parameter:', error)
            }
          }

          if (req.method === 'POST') {
            let transport: StreamableHTTPServerTransport

            if (sessionId && transports[sessionId]) {
              transport = transports[sessionId]
            } else if (!sessionId && isInitializeRequest(body)) {
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true,
                onsessioninitialized: (newSessionId) => {
                  sessionClientInfo[newSessionId] = mcpClient
                  transports[newSessionId] = transport
                  const server = createServerInstance(mcpClient, newSessionId)
                  servers[newSessionId] = server
                  server.connect(transport).catch(console.error)
                },
              })

              transport.onclose = () => {
                if (transport.sessionId) {
                  delete transports[transport.sessionId]
                  delete servers[transport.sessionId]
                  delete sessionClientInfo[transport.sessionId]
                }
              }
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                  },
                  id: null,
                }),
              )
              return
            }

            await transport.handleRequest(req, res, body)
          } else if (req.method === 'DELETE') {
            const sessionId = req.headers['mcp-session-id'] as string | undefined
            if (sessionId && transports[sessionId]) {
              await transports[sessionId].close()
              res.writeHead(200)
              res.end()
              return
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                  },
                  id: null,
                }),
              )
            }
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Method not allowed' }))
          }
        } else if (url === '/ping') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('pong')
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      } catch (error) {
        console.error('Error handling request:', error)
        if (!res.headersSent) {
          res.writeHead(500)
          res.end('Internal Server Error')
        }
      } finally {
        // Clear config after request processing
        currentApiKey = undefined
      }
    })

    httpServer.listen(HTTP_PORT, () => {
      console.error(`Ref MCP Server running on HTTP at http://localhost:${HTTP_PORT}/mcp`)
    })
  } else {
    // Stdio transport (default)
    const sessionId = randomUUID()
    const server = createServerInstance('ref-tools-mcp-stdio', sessionId)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('Ref MCP Server running on stdio')
  }
}

process.on('SIGINT', async () => {
  process.exit(0)
})

main().catch((error) => {
  console.error('Fatal error running server:', error)
  process.exit(1)
})

// Export the server for smithery
export default function () {
  const server = createServerInstance()
  return server
}

// Initialize local code search agent once per process if env is set
;(async () => {
  try {
    const dir = process.env.REF_DIRECTORY
    const openai = process.env.OPENAI_API_KEY
    if (dir && openai) {
      codeSearchAgent = new SearchAgent(dir, {
        watch: true,
        openaiApiKey: openai,
        annotator: openai ? makeOpenAIAnnotator({ apiKey: openai }) : undefined,
        relevanceFilter: openai ? pickChunksFilter : undefined,
      })
      // Kick off initial ingest in background
      codeSearchAgent.ingest().catch((e) => console.error('SearchAgent ingest error:', e))
      console.error('Local code SearchAgent initialized for', dir)
    } else {
      console.error(
        'Local code search disabled. Set REF_DIRECTORY and OPENAI_API_KEY to enable search_code_* tools.',
      )
    }
  } catch (e) {
    console.error('Failed to initialize local code SearchAgent:', e)
  }
})()
