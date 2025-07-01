/**
 * @fileoverview Implements an MCP server using `Server` and `StdioServerTransport` to expose tools like `ref_search_documentation` (using `doSearch`) and `ref_read_url` (using `doRead`). It handles `ListToolsRequestSchema` and `CallToolRequestSchema` requests to execute these tools.
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

const server = new Server(
  {
    name: 'Ref',
    version: '2.0.0',
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

const SEARCH_DOCUMENTATION_TOOL: Tool = {
  name: 'ref_search_documentation',
  description: `A powerful search tool to check technical documentation. Great for finding facts or code snippets. Can be used to search for public documentation on the web or github as well from private resources like repos and pdfs.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: `Query to search for relevant documentation. This should be a full sentence or question.`,
      },
      keyWords: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'A list of keywords to use for the search like you would use for grep',
      },
      source: {
        type: 'string',
        enum: ['all', 'public', 'private', 'web'],
        description:
          "Defaults to 'all'. 'public' is used when the user is asking about a public API or library. 'private' is used when the user is asking about their own private repo or pdfs. 'web' is use only as a fallback when 'public' has failed.",
      },
    },
    required: ['query'],
  },
}

const READ_TOOL: Tool = {
  name: 'ref_read_url',
  description: `A tool that fetches content from a URL and converts it to markdown for easy reading with Ref. 

This is powerful when used in conjunction with the ref_search_documentation or ref_search_web tool that return urls of relevant content.`,
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SEARCH_DOCUMENTATION_TOOL, READ_TOOL],
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
          description: 'The rest of your prompt or question you want informed by your private docs',
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
            text: `${query}\n\nRemember to check the docs with ref`,
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
            text: `${query}\n\nSearch my private docs with ref`,
          },
        },
      ],
    }
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`)
})

const getRefUrl = () => {
  if (process.env.REF_URL) {
    return process.env.REF_URL
  }
  return 'https://api.ref.tools'
}

let moduleNames: string[] | undefined = undefined

async function doSearch(query: string, keyWords?: string[], source?: string) {
  // Handle web search through Tavily when source is 'web'
  if (source === 'web') {
    return doSearchWeb(query)
  }

  const url =
    getRefUrl() +
    '/search_documentation?query=' +
    encodeURIComponent(query) +
    (keyWords && keyWords.length > 0 ? '&keyWords=' + keyWords.join(',') : '') +
    (source ? '&source=' + source : '') +
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
          text: `Found ${data.docs.length} results for "${query}"\n\n${data.docs.map((result: any) => result.url).join('\n')}`,
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

    // Format the results to match the endpoint format
    return {
      content: data.docs.map((result: any) => ({ type: 'text', text: JSON.stringify(result) })),
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
          text: `Title: ${data.title}\n\n${data.content}`,
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
    const input = request.params.arguments as {
      query: string
      keyWords?: string[]
      source?: string
    }
    return doSearch(input.query, input.keyWords, input.source)
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

// Export the server for smithery
export default function () {
  return server
}
