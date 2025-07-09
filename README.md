[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/ref-tools-ref-tools-mcp-badge.png)](https://mseep.ai/app/ref-tools-ref-tools-mcp)

[![Documentation for your agent](header.png)](https://ref.tools)
[![smithery badge](https://smithery.ai/badge/@ref-tools/ref-tools-mcp)](https://smithery.ai/server/@ref-tools/ref-tools-mcp)

# Ref MCP

A [ModelContextProtocol](https://modelcontextprotocol.io) server that gives your AI coding tool or agent access to documentation for APIs, services, libraries etc. It's your one-stop-shop to keep your agent up-to-date on documentation in a fast and token-efficient way.

For more see info [ref.tools](https://ref.tools)

## Setup

There are two options for setting up Ref as an MCP server, either via the streamable-http server (experimental) or local stdio server. 

This repo contains the legacy stdio server. 

### Streamable HTTP (recommended)

[![Install Ref MCP in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=Ref&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1jcC1yZW1vdGVAMC4xLjAtMCIsImh0dHBzOi8vYXBpLnJlZi50b29scy9tY3AiLCItLWhlYWRlcj14LXJlZi1hcGkta2V5OjxzaWduIHVwIHRvIGdldCBhbiBhcGkga2V5PiJdfQ==)

```
"Ref": {
    "command": "npx",
    "args": [
      "-y",
      "mcp-remote@0.1.0-0",
      "https://api.ref.tools/mcp",
      "--header=x-ref-api-key:<sign up to get an api key>"
    ]
  }
}
```

### stdio 

[![Install Ref MCP in Cursor (stdio)](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=Ref&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJyZWYtdG9vbHMtbWNwIl0sImVudiI6eyJSRUZfQVBJX0tFWSI6IjxzaWduIHVwIHRvIGdldCBhbiBhcGkga2V5PiJ9fQ==)

```
"Ref": {
  "command": "npx",
  "args": ["ref-tools-mcp"],
  "env": {
    "REF_API_KEY": <sign up to get an api key>
  }
}
```


As of April 2025, MCP supports streamable HTTP servers. Ref implements this but not all clients support it yet so the most reliable approach is to use `mcp-remote` as a local proxy. If you know your client supports streamable HTTP servers, feel free to use https://api.ref.tools/mcp directly.

Note for former alpha users: `REF_ALPHA` config is still supported. You'll be notified if you need to update.

## Tools

Ref MCP server provides all the documentation related tools for your agent needs.

### ref_search_documentation

A powerful search tool to check technical documentation. Great for finding facts or code snippets. Can be used to search for public documentation on the web or github as well from private resources like repos and pdfs.

**Parameters:**
- `query` (required): Query to search for relevant documentation. This should be a full sentence or question.
- `keyWords` (optional): A list of keywords to use for the search like you would use for grep.
- `source` (optional): Defaults to 'all'. 'public' is used when the user is asking about a public API or library. 'private' is used when the user is asking about their own private repo or pdfs. 'web' is use only as a fallback when 'public' has failed.

**Note:** When `source` is set to 'web', this tool will perform web search to find relevant information online.

### ref_read_url

A tool that fetches content from a URL and converts it to markdown for easy reading with Ref. This is powerful when used in conjunction with the ref_search_documentation tool that returns urls of relevant content.

**Parameters:**
- `url` (required): The URL of the webpage to read.

## Development

```
npm install
npm run dev
```

### Running with Inspector

For development and debugging purposes, you can use the MCP Inspector tool. The Inspector provides a visual interface for testing and monitoring MCP server interactions.

Visit the [Inspector documentation](https://modelcontextprotocol.io/docs/tools/inspector) for detailed setup instructions.

To test locally with Inspector:
```
npm run inspect
```

Or run both the watcher and inspector:
```
npm run dev
```

### Local Development

1. Clone the repository
2. Install dependencies:
```bash
npm install
```
3. Build the project:
```bash
npm run build
```
4. For development with auto-rebuilding:
```bash
npm run watch
```

## License

MIT
