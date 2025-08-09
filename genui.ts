import { createUIResource } from '@mcp-ui/server'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

export const generateUiTool: Tool = {
  name: 'generate_ui',
  description:
    'Generates an HTML UI based on the input message using Vercel AI SDK v5 with OpenAI gpt-5 and returns it as an MCP-UI HTML resource.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'High-level description of the UI you want. Example: "Form to collect name and email".',
      },
      title: {
        type: 'string',
        description: 'Optional page title heading to include in the generated UI.',
      },
      theme: {
        type: 'string',
        description: 'Optional style hint such as "minimal", "dashboard", or "card".',
      },
    },
    required: ['message'],
  },
}

export async function callGenerateUi(args: { message: string; title?: string; theme?: string }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      content: [
        {
          type: 'text',
          text: 'Missing OPENAI_API_KEY. Please set it in your environment to use generate_ui.',
        },
      ],
    }
  }

  const system = [
    'You are a UI generator that outputs a COMPLETE, SELF-CONTAINED HTML document.',
    'Constraints:',
    '- Only output HTML (with inline CSS and minimal inline JS if needed).',
    '- Mobile-friendly, accessible (labels for inputs, ARIA where applicable).',
    '- No external network requests, fonts, or images.',
    '- Keep the document lightweight (<5KB ideally).',
    '- Use semantic elements, simple components, and neutral styling.',
  ].join('\n')

  const userInstruction = [
    args.title ? `Title: ${args.title}` : undefined,
    args.theme ? `Theme: ${args.theme}` : undefined,
    `UI request: ${args.message}`,
  ]
    .filter(Boolean)
    .join('\n')

  const { text: html } = await generateText({
    model: openai('gpt-5'),
    system,
    prompt: userInstruction,
  })

  const fullHtml = ensureHtmlDocument(html)

  const uiResource = createUIResource({
    uri: `ui://ref-tools-mcp/genui-${Date.now()}`,
    content: { type: 'rawHtml', htmlString: fullHtml },
    encoding: 'text',
  }) as unknown as any

  return { content: [uiResource] as any }
}

function ensureHtmlDocument(maybeHtml: string): string {
  const trimmed = (maybeHtml || '').trim()
  const hasHtmlTag = /<html[\s\S]*?>[\s\S]*<\/html>/i.test(trimmed)
  if (hasHtmlTag) {
    // Inject a small auto-resize script so hosts that support ui-size-change can grow the iframe
    const resizeScript = `\n<script>(function(){try{var post=function(h){if(window.parent){window.parent.postMessage({type:'ui-size-change',payload:{height:h}},'*')}};var target=document.documentElement;var send=function(){var h=Math.max(target.scrollHeight,document.body?document.body.scrollHeight:0,target.clientHeight);post(h)};var ro=new ResizeObserver(function(entries){entries.forEach(function(e){post(Math.ceil(e.contentRect.height))})});var init=function(){ro.observe(target);send()};if(document.readyState==='complete'||document.readyState==='interactive'){init()}else{window.addEventListener('DOMContentLoaded',init)}}catch(e){}})();</script>`
    if (/<\/body>/i.test(trimmed)) return trimmed.replace(/<\/body>/i, `${resizeScript}</body>`)
    if (/<\/html>/i.test(trimmed)) return trimmed.replace(/<\/html>/i, `${resizeScript}</html>`)
    return trimmed + resizeScript
  }
  // Wrap partial HTML into a minimal document
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      html, body { min-height: 640px; }
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin: 0; padding: 16px; }
      .container { max-width: 720px; margin: 0 auto; min-height: 640px; }
    </style>
  </head>
  <body>
    <div class="container">${trimmed}</div>
    <script>(function(){try{var post=function(h){if(window.parent){window.parent.postMessage({type:'ui-size-change',payload:{height:h}},'*')}};var target=document.documentElement;var send=function(){var h=Math.max(target.scrollHeight,document.body?document.body.scrollHeight:0,target.clientHeight);post(h)};var ro=new ResizeObserver(function(entries){entries.forEach(function(e){post(Math.ceil(e.contentRect.height))})});var init=function(){ro.observe(target);send()};if(document.readyState==='complete'||document.readyState==='interactive'){init()}else{window.addEventListener('DOMContentLoaded',init)}}catch(e){}})();</script>
  </body>
</html>`
}
