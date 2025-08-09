import { createUIResource } from '@mcp-ui/server'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const uiHelloTool: Tool = {
  name: 'ui_hello',
  description: 'Returns a simple HTML UI snippet using mcp-ui.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}

export function callUiHello() {
  const html = `<!doctype html>
<html>
  <body style="background-color: #000000; height: 640px;">
    <h1 style="color: #ffffff;">v6 - height test</h1>
    <script>
    window.parent.postMessage(
        {
          type: "ui-size-change",
          payload: {
            height: 640,
          },
        },
        "*"
      );
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
