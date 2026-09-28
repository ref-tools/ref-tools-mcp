/**
 * @fileoverview Ref MCP server with documentation search and URL reading tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import axios from 'axios'
import { randomUUID } from 'crypto'

const SEARCH_TOOL_NAME = 'ref_search_documentation'
const READ_TOOL_NAME = 'ref_read_url'

if (process.env.TRANSPORT === 'http') {
  console.error(
    'HTTP mode was removed in ref-tools-mcp 4.0.0 (GHSA-jcmm-p959-xh5c). Connect to https://api.ref.tools/mcp instead.',
  )
  process.exit(1)
}

function createMcpServer(sessionId?: string) {
  const searchTool: Tool = {
    name: SEARCH_TOOL_NAME,
    description: `Search for documentation on the web or github as well from private resources like repos and pdfs. Use Ref '${READ_TOOL_NAME}' to read the content of a url.`,
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
    annotations: {
      readOnlyHint: true,
    },
  }

  const readTool: Tool = {
    name: READ_TOOL_NAME,
    description: `Read the content of a url as markdown. The EXACT url from a '${SEARCH_TOOL_NAME}' result should be passed to this tool.`,
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
    annotations: {
      readOnlyHint: true,
    },
  }

  const server = new Server(
    {
      name: 'Ref',
      version: '4.0.0',
    },
    {
      capabilities: {
        prompts: {
          listChanged: true,
        },
        tools: {},
        logging: {},
      },
      instructions: `Use ref_search_documentation and ref_read_url when working with libraries, frameworks or APIs to check the docs.`,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [searchTool, readTool],
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
    if (request.params.name === SEARCH_TOOL_NAME) {
      console.error('[search_documentation] arguments', request.params.arguments)
      const input = request.params.arguments as {
        query: string
      }
      return doSearch(input.query, sessionId)
    }

    if (request.params.name === READ_TOOL_NAME) {
      const input = request.params.arguments as { url: string }
      return doRead(input.url, sessionId)
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

const getApiKey = () => {
  return process.env.REF_ALPHA || process.env.REF_API_KEY
}

const getAuthHeaders = (sessionId?: string) => {
  const headers: Record<string, string | undefined> = {
    'X-Ref-Alpha': process.env.REF_ALPHA,
    'X-Ref-Api-Key': process.env.REF_API_KEY,
  }

  if (sessionId) {
    headers['mcp-session-id'] = sessionId
  }

  return headers
}

const missingKeyMessage = 'Ref is missing an API key. Reach out to hello@ref.tools for help.'

async function doSearch(query: string, sessionId?: string) {
  const url = getRefUrl() + '/search_documentation?query=' + encodeURIComponent(query)
  console.error('[search]', url)

  if (!getApiKey()) {
    return {
      content: [
        {
          type: 'text',
          text: missingKeyMessage,
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

    return {
      content: data.docs.map((doc: any) => ({
        type: 'text' as const,
        text: `overview: ${doc.overview || ''}
url: ${doc.url}
moduleId: ${doc.moduleId || ''}`,
      })),
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      return {
        content: [
          {
            type: 'text',
            text: 'Please verify your email at https://ref.tools/dashboard to search documentation',
          },
        ],
      }
    }

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

async function doRead(url: string, sessionId?: string) {
  try {
    const readUrl = getRefUrl() + '/read?url=' + encodeURIComponent(url)
    console.error('[read]', readUrl)

    if (!getApiKey()) {
      return {
        content: [
          {
            type: 'text',
            text: missingKeyMessage,
          },
        ],
      }
    }

    const response = await axios.get(readUrl, {
      headers: getAuthHeaders(sessionId),
    })

    const data = response.data

    return {
      content: [{ type: 'text', text: data.content || '' }],
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      return {
        content: [
          {
            type: 'text',
            text: 'Please verify your email at https://ref.tools/dashboard to read URLs',
          },
        ],
      }
    }

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
  const sessionId = randomUUID()
  const server = createMcpServer(sessionId)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Ref MCP Server running on stdio')
}

process.on('SIGINT', async () => {
  process.exit(0)
})

main().catch((error) => {
  console.error('Fatal error running server:', error)
  process.exit(1)
})
