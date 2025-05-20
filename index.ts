/**
 * @fileoverview Implements an MCP server using `Server` and `StdioServerTransport` to expose tools like `ref_search_documentation` (using `doSearch`), `ref_read` (using `doRead`), and `ref_search_web` (using `doSearchWeb`). It handles `ListToolsRequestSchema` and `CallToolRequestSchema` requests to execute these tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import axios from 'axios'

const server = new Server(
  {
    name: 'Ref',
    version: '0.12.0',
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  },
)

const SEARCH_DOCUMENTATION_TOOL: Tool = {
  name: 'ref_search_documentation',
  description: `A powerful search tool to check technical documentation. Whenever you need to respond about any technical platform, framework, api, service, database, library, etc you should use this tool to check the documentation, even if you think you know the answer. Make sure to include the language and any other relevant context in the query.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: `Query to search for relevant documentation. 
        
Make sure to include the user's query as well as other important context you have such as languages and frameworks being used that the user didn't mention directly. 

The query should be in full sentence form. Be clear and include all the relevant context.`,
      },
    },
    required: ['query'],
  },
}

const SEARCH_WEB_TOOL: Tool = {
  name: 'ref_search_web',
  description: `Search the web for information. This should be used as a fallback when the ref_search_documentation tool doesn't have the information you need.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.',
      },
    },
    required: ['query'],
  },
}

const READ_TOOL: Tool = {
  name: 'ref_read',
  description: `A tool that fetches content from a URL and converts it to markdown for easy reading. 

This is powerful when used in conjunction with the ref_search_documentation or ref_search_web tool that return urls of relevant content.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL of the webpage to read and convert to markdown.',
      },
    },
    required: ['url'],
  },
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools:
    process.env.DISABLE_SEARCH_WEB === 'true'
      ? [SEARCH_DOCUMENTATION_TOOL, READ_TOOL]
      : [SEARCH_DOCUMENTATION_TOOL, READ_TOOL, SEARCH_WEB_TOOL],
}))

const getRefUrl = () => {
  if (process.env.REF_URL) {
    return process.env.REF_URL
  }
  return 'https://api.ref.tools'
}

let moduleNames: string[] | undefined = undefined

async function doSearch(query: string) {
  const url =
    getRefUrl() +
    '/search_documentation?query=' +
    encodeURIComponent(query) +
    (moduleNames ? '&moduleNames=' + moduleNames?.join(',') : '')
  console.error('[search]', url)

  if (!process.env.REF_ALPHA && !process.env.REF_API_KEY) {
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
      headers: {
        'X-Ref-Alpha': process.env.REF_ALPHA,
        'X-Ref-Api-Key': process.env.REF_API_KEY,
      },
    })
    const data = response.data

    if (data.docs.length === 0) {
      return {
        content: [{ type: 'text', text: 'No results found' }],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `Found ${data.docs.length} results for ${query} from ${getRefUrl()}\n\n${data.docs.map((result: any) => result.url).join('\n')}`,
        },
        ...data.docs.map((result: any) => ({
          type: 'text',
          text: JSON.stringify(result),
        })),
      ],
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

async function doSearchWeb(query: string) {
  try {
    const searchWebUrl = getRefUrl() + '/search_web?query=' + encodeURIComponent(query)
    console.error('[search_web]', searchWebUrl)

    if (!process.env.REF_ALPHA && !process.env.REF_API_KEY) {
      return {
        content: [
          {
            type: 'text',
            text: 'Ref is not correctly configured. Reach out to hello@ref.tools for help.',
          },
        ],
      }
    }

    const response = await axios.get(searchWebUrl, {
      headers: {
        'X-Ref-Alpha': process.env.REF_ALPHA,
        'X-Ref-Api-Key': process.env.REF_API_KEY,
      },
    })

    const data = response.data

    if (!data.docs || data.docs.length === 0) {
      return {
        content: [{ type: 'text', text: 'No web search results found' }],
      }
    }

    // Format the results in a readable way for the LLM
    const formattedResults = data.docs
      .map((result: any) => {
        return JSON.stringify(result)
      })
      .join('\n\n')

    return {
      content: [{ type: 'text', text: formattedResults }],
    }
  } catch (error) {
    console.error('[search_web-error]', error)
    return {
      content: [
        {
          type: 'text',
          text: `Error during web search: ${axios.isAxiosError(error) ? error.message : (error as Error).message}`,
        },
      ],
    }
  }
}

async function doRead(url: string) {
  try {
    const readUrl = getRefUrl() + '/read?url=' + encodeURIComponent(url)
    console.error('[read]', readUrl)

    if (!process.env.REF_ALPHA && !process.env.REF_API_KEY) {
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
      headers: {
        'X-Ref-Alpha': process.env.REF_ALPHA,
        'X-Ref-Api-Key': process.env.REF_API_KEY,
      },
    })

    const data = response.data

    return {
      content: [
        {
          type: 'text',
          canCrawl: data.allowed,
          text: data.content || 'No content could be extracted from the URL.',
        },
      ],
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === SEARCH_DOCUMENTATION_TOOL.name) {
    console.error('[search_documentation] arguments', request.params.arguments)
    const input = request.params.arguments as { query: string }
    return doSearch(input.query)
  }

  if (request.params.name === SEARCH_WEB_TOOL.name) {
    console.error('[search_web] arguments', request.params.arguments)
    const input = request.params.arguments as { query: string }
    return doSearchWeb(input.query)
  }

  if (request.params.name === READ_TOOL.name) {
    const input = request.params.arguments as { url: string }
    return doRead(input.url)
  }

  throw new McpError(ErrorCode.MethodNotFound, `Could not find tool: ${request.params.name}`)
})

server.onerror = (error: any) => {
  console.error(error)
}

process.on('SIGINT', async () => {
  await server.close()
  process.exit(0)
})

async function runServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('MCP Starter Server running on stdio')
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error)
  process.exit(1)
})
