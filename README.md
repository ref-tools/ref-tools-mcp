# Ref MCP Server

A [ModelContextProtocol](https://modelcontextprotocol.io) that gives your AI coding tool or agent access to documentation for APIs, services, libraries etc.

## Features

The server providest tools:

- `search`: Search for documentation related to your specific stack. 
- `stack`: Read your project directory so that `search` references documentation for exactly your stack. (Not intended for users to invoke, just visible for demo purposes)

## Setup with Claude

1. Download and install Claude desktop app from [claude.ai/download](https://claude.ai/download)

2. Configure Claude to use this MCP server. If this is your first MCP server, run:

```bash
echo '{
  "mcpServers": {
    "ref": {
      "command": "npx",
      "args": ["ref-tools-mcp"],
      "env": {
        "STACK_DIR": "<absolute path to the project codebase>"
      }
    }
  }
}' > ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

If you have existing MCP servers, add the `mcp-starter` block to your existing config.

3. Restart Claude Desktop.

4. Look for the hammer icon with the number of available tools in Claude's interface to confirm the server is running.

## Development Setup

Run the Ref local dev stack including Firebase emulator from the root of the repo with `npm run dev -- ref`

Then get the base url for emulator Firebase function (eg `http://127.0.0.1:5001/ref-dev-mjd/us-central1/`) set that as `env.REF_URL` 

See `ref-tools` docs for how to index files to the local stack.

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
