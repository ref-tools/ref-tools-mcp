import { createUIResource } from '@mcp-ui/server'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const uiHelloTool: Tool = {
  name: 'ui_hello',
  description: 'Returns a simple HTML UI snippet using mcp-ui.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional heading text to show in the UI.',
      },
      message: {
        type: 'string',
        description: 'Optional paragraph text to show in the UI.',
      },
    },
  },
}

export function callUiHello(args: { title?: string; message?: string }) {
  const title = args.title || 'Hello from Ref MCP + MCP-UI'
  const message =
    args.message ||
    'This UI is rendered via an HTML resource. Click the button to send a notify action to the host.'

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin: 0; padding: 16px; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { margin: 0 0 12px; color: #374151; }
      button { background: #111827; color: white; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
      button:hover { background: #0b1220; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title.replace(/</g, '&lt;')}</h1>
      <p>${message.replace(/</g, '&lt;')}</p>
      <button id="notifyBtn">Notify host</button>
    </div>
    <script>
      const send = (payload) => {
        window.parent?.postMessage(payload, '*');
      };
      document.getElementById('notifyBtn').addEventListener('click', () => {
        send({ type: 'notify', payload: { message: 'Button clicked inside MCP-UI iframe' } });
      });
    </script>
    <script>
    const resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        window.parent.postMessage(
          {
            type: "ui-size-change",
            payload: {
              height: entry.contentRect.height,
            },
          },
          "*"
        );
      });
    });

    resizeObserver.observe(document.documentElement);
    </script>
  </body>
</html>`

  const uiResource = createUIResource({
    uri: `ui://ref-tools-mcp/ui-hello-${Date.now()}`,
    content: { type: 'rawHtml', htmlString: html },
    encoding: 'text',
  }) as unknown as any

  return { content: [uiResource] as any }
}
