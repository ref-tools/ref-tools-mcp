[![Documentation for your agent](header.png)](https://ref.tools)
[![smithery badge](https://smithery.ai/badge/@ref-tools/ref-tools-mcp)](https://smithery.ai/server/@ref-tools/ref-tools-mcp)

# Ref MCP

A [ModelContextProtocol](https://modelcontextprotocol.io) server that gives your AI coding tool or agent access to documentation for APIs, services, libraries etc. It's your one-stop-shop to keep your agent up-to-date on documentation in a fast and token-efficient way.

<a href="https://glama.ai/mcp/servers/@ref-tools/ref-tools-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@ref-tools/ref-tools-mcp/badge" alt="Ref MCP server" />
</a>

For more see info [ref.tools](https://ref.tools)

## Setup

There are two options for setting up Ref as an MCP server, either via the streamable-http server (experimental) or local stdio server. 

This repo contains the legacy stdio server. 

### stdio 

```
"Ref": {
  "command": "npx",
  "args": ["ref-tools-mcp"],
  "env": {
    "REF_API_KEY": <sign up to get an api key>
  }
}
```

### Streamable HTTP (experimental)

```
"Ref": {
    "command": "npx",
    "args": [
      "-y",
      "mcp-remote@0.1.0-0",
      "https://api.ref.tools/mcp"
      "--header",
      "x-ref-api-key:<sign up to get an api key>"
    ]
  }
}
```

As of April 2025, MCP supports streamable HTTP servers. Ref implements this but not all clients support it yet so the most reliable approach is to use `mcp-remote` as a local proxy. If you know your client supports streamable HTTP servers, feel free to use https://api.ref.tools/mcp directly.

Note for former alpha users: `REF_ALPHA` config is still supported. You'll be notified if you need to update.

## Tools

Ref MCP server provides all the documentation related tools for your agent needs.

### ref_search_documentation

A powerful search tool to check technical documentation. Use this tool whenever you need information about any technical platform, framework, API, service, database, or library. It searches through relevant documentation and finds exactly what you need, down to the specific section of the page.

### ref_read_url

A tool to read the full content of a web page. This allows your agent to follow links in documentation and web searches.

### ref_search_web (optional)

A fallback web search tool to cover cases when `ref_search_documentation` doesn't find what you need. It will find links to relevant pages on the web and the `ref_read_url` tool can be used to read the relevant ones.

We include this tool so that Ref can cover all your search needs in one MCP server but if you prefer another search provider you can disable `ref_search_web` by setting the `DISABLE_SEARCH_WEB` environment variable to `true` or by setting the `disable_search_web=false` url param in the streamable-http server.

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