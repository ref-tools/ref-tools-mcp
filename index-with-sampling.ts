/**
 * @fileoverview Enhanced Ref MCP server with MCP sampling for intelligent search
 * 
 * This version integrates MCP sampling to provide more intelligent search result
 * selection and ranking based on relevance analysis.
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
import { SamplingSearchHandler, createSamplingSearchTool } from './sampling-search.js'

// Tool configuration based on client type
type ToolConfig = {
  searchToolName: string
  readToolName: string
  useSampling: boolean
}

const OPENAI_DEEP_RESEARCH_TOOL_CONFIG: ToolConfig = {
  searchToolName: 'search',
  readToolName: 'fetch',
  useSampling: false, // OpenAI may have its own sampling
}

const DEFAULT_TOOL_CONFIG: ToolConfig = {
  searchToolName: 'ref_search_documentation',
  readToolName: 'ref_read_url',
  useSampling: true, // Enable sampling for default clients
}

// Transport configuration from environment
const TRANSPORT_TYPE = (process.env.TRANSPORT || 'stdio') as 'stdio' | 'http'
const HTTP_PORT = parseInt(process.env.PORT || '8080', 10)

// Global variables to store current request config
let currentApiKey: string | undefined = undefined

// Session management for HTTP transport
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}
const sessionClientInfo: { [sessionId: string]: string } = {}
const servers: { [sessionId: string]: Server } = {}
const samplingHandlers: { [sessionId: string]: SamplingSearchHandler } = {}

// Function to create a new server instance
function createServerInstance(mcpClient: string = 'unknown', sessionId?: string) {
  const toolConfig =
    mcpClient === 'openai-mcp' ? OPENAI_DEEP_RESEARCH_TOOL_CONFIG : DEFAULT_TOOL_CONFIG

  const server = new Server(
    {
      name: 'Ref',
      version: '3.1.0', // Bumped version for sampling feature
    },
    {
      capabilities: {
        prompts: {
          listChanged: true,
        },
        tools: {},
        logging: {},
        // Enable sampling capability if needed
        sampling: toolConfig.useSampling ? {} : undefined,
      },
    },
  )

  // Create sampling handler if enabled
  let samplingHandler: SamplingSearchHandler | undefined
  if (toolConfig.useSampling && sessionId) {
    samplingHandler = new SamplingSearchHandler(server, {
      maxResults: 5,
      minRelevanceScore: 0.6,
      enableContextAwareFiltering: true,
      enableSessionTracking: true,
      modelPreferences: {
        intelligencePriority: 0.8, // Higher for better analysis
        speedPriority: 0.5,
        costPriority: 0.3,
      },
    })
    samplingHandlers[sessionId] = samplingHandler
  }

  // Standard search tool
  const searchTool: Tool = {
    name: toolConfig.searchToolName,
    description: `Search for documentation on the web or github as well from private resources like repos and pdfs. ${
      toolConfig.useSampling ? 'Uses intelligent ranking with MCP sampling.' : ''
    } Use Ref '${toolConfig.readToolName}' to read the content of a url.`,
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

  // Enhanced search tool with sampling (if enabled)
  const samplingSearchTool: Tool | undefined = toolConfig.useSampling && samplingHandler
    ? {
        name: 'ref_search_with_intelligence',
        description: 'Advanced search with AI-powered result ranking and relevance analysis. Learns from search patterns to improve results.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for documentation',
            },
            analyzeIntent: {
              type: 'boolean',
              description: 'Analyze search intent from session history',
            },
          },
          required: ['query'],
        },
      }
    : undefined

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

  // Register request handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [searchTool, readTool]
    if (samplingSearchTool) {
      tools.push(samplingSearchTool)
    }
    return { tools }
  })

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
      {
        name: 'intelligent_search',
        description:
          'Search with AI-powered ranking that learns from your search patterns for better results.',
        arguments: [
          {
            name: 'query',
            description: 'Your search query',
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

    if (name === 'intelligent_search') {
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
              text: `${query}\n\nUse intelligent search with MCP sampling for best results`,
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
      const input = request.params.arguments as { query: string }
      
      // Use sampling if available and enabled
      if (toolConfig.useSampling && samplingHandler && sessionId) {
        try {
          const results = await samplingHandler.performSamplingSearch(
            input.query,
            sessionId,
            currentApiKey
          )
          
          return {
            content: results.map(r => ({
              type: 'text' as const,
              text: `[Relevance: ${r.relevanceScore?.toFixed(2) || 'N/A'}]
${r.title || r.overview}
URL: ${r.url}
${r.relevanceReason ? `Why: ${r.relevanceReason}` : ''}
${r.contextMatch ? `Matches: ${r.contextMatch.join(', ')}` : ''}`,
            })),
          }
        } catch (error) {
          console.error('Sampling search failed, falling back:', error)
          // Fall back to standard search
        }
      }
      
      return doSearch(input.query, mcpClient, sessionId)
    }

    if (request.params.name === 'ref_search_with_intelligence') {
      if (!samplingHandler) {
        throw new McpError(ErrorCode.InvalidRequest, 'Intelligent search not available')
      }
      
      const input = request.params.arguments as { query: string; analyzeIntent?: boolean }
      
      if (input.analyzeIntent && sessionId) {
        const intent = await samplingHandler.analyzeSearchIntent(sessionId)
        console.log(`Search intent detected: ${intent}`)
      }
      
      const results = await samplingHandler.performSamplingSearch(
        input.query,
        sessionId,
        currentApiKey
      )
      
      // Get session stats
      const stats = sessionId ? samplingHandler.getSessionStats(sessionId) : null
      
      const content = results.map(r => ({
        type: 'text' as const,
        text: `[Score: ${r.relevanceScore?.toFixed(2) || 'N/A'}] ${r.title}
URL: ${r.url}
${r.relevanceReason || r.overview}
${r.contextMatch ? `Key matches: ${r.contextMatch.join(', ')}` : ''}`,
      }))
      
      if (stats && stats.searchCount > 1) {
        content.push({
          type: 'text' as const,
          text: `\n---\nSession insights: ${stats.searchCount} searches, ${stats.viewedUrls} URLs viewed${
            stats.currentIntent ? `, Intent: ${stats.currentIntent}` : ''
          }`,
        })
      }
      
      return { content }
    }

    if (request.params.name === toolConfig.readToolName) {
      const input = request.params.arguments as { url: string }
      return doRead(input.url, mcpClient, sessionId)
    }

    throw new McpError(ErrorCode.MethodNotFound, `Could not find tool: ${request.params.name}`)
  })

  server.onerror = (error: any) => {
    console.error(error)
  }

  return server
}

// Helper functions (same as original)
const getRefUrl = () => {
  if (process.env.REF_URL) {
    return process.env.REF_URL
  }
  return 'https://api.ref.tools'
}

const getApiKey = () => {
  return process.env.REF_ALPHA || process.env.REF_API_KEY || currentApiKey
}

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

// Standard search and read functions (keeping original implementations)
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
            text: JSON.stringify(data.docs.map((doc: any) => ({
              id: doc.url,
              title: doc.overview || doc.title || '',
              text: (doc.content || '').slice(0, 100),
              url: doc.url,
              metadata: {
                moduleId: doc.moduleId,
              },
            }))),
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
      const result = {
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

// Main function with HTTP and stdio support
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
                  // Clean up sampling handler
                  if (samplingHandlers[transport.sessionId]) {
                    samplingHandlers[transport.sessionId].clearSession(transport.sessionId)
                    delete samplingHandlers[transport.sessionId]
                  }
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
            console.log('DELETE request', transports[req.headers['mcp-session-id'] as string])
            const sessionId = req.headers['mcp-session-id'] as string | undefined
            if (sessionId && transports[sessionId]) {
              await transports[sessionId].close()
              console.log('closed transport', sessionId)
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
      console.error(`Enhanced Ref MCP Server with Sampling running on HTTP at http://localhost:${HTTP_PORT}/mcp`)
    })
  } else {
    // Stdio transport (default)
    const sessionId = randomUUID()
    const server = createServerInstance('ref-tools-mcp-stdio', sessionId)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('Enhanced Ref MCP Server with Sampling running on stdio')
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