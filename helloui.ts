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
  <body style="margin:0; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif;">
    <h1>UI Resize Test</h1>
    <button id="grow">Grow height</button>
    <div id="pad" style="height: 120px;"></div>
    <script>
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          window.parent.postMessage(
            { type: "ui-size-change", payload: { height: entry.contentRect.height } },
            "*"
          );
        }
      });
      ro.observe(document.documentElement);

      document.getElementById('grow').addEventListener('click', () => {
        const pad = document.getElementById('pad');
        pad.style.height = (pad.offsetHeight + 240) + 'px';
      });
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
