import { createUIResource } from '@mcp-ui/server'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

// Lightweight snapshot shape imported structurally from graphdb without runtime import
type GraphSnapshot = {
  nodes: Array<{ id: number; labels: string[]; properties: Record<string, any> }>
  relationships: Array<{
    id: number
    type: string
    from: number
    to: number
    properties: Record<string, any>
  }>
}

export const visualizeCodeTool: Tool = {
  name: 'visualize_code',
  description:
    'Generates an HTML UI that visualizes or explains the codebase based on a prompt. The tool is already aware of the code graph (nodes, relationships) as context.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Prompt describing what to visualize about the codebase.',
      },
    },
    required: ['description'],
  },
}

export async function callVisualizeCode(args: {
  message: string
  title?: string
  graph?: GraphSnapshot | undefined
}) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      content: [
        {
          type: 'text',
          text: 'Missing OPENAI_API_KEY. Please set it in your environment to use visualize_code.',
        },
      ],
    }
  }

  // Build system prompt focused on generating a complete HTML UI
  const system = [
    'You generate an interactive, COMPLETE HTML document that visualizes codebases.',
    'Constraints:',
    '- Output only HTML (with inline CSS and minimal inline JS).',
    '- Be mobile-friendly and accessible (labels/ARIA as appropriate).',
    '- No external network requests, fonts, or images.',
    '- Use simple, semantic markup; keep it lightweight.',
    '- If a graph snapshot is provided, use it to drive charts, lists, or diagrams.',
    '- If the user references specific files in the prompt, reflect them clearly in the UI.',
  ].join('\n')

  // Prepare graph context as YAML (conservative truncation to avoid huge prompts)
  const graphYaml = args.graph ? safeYaml(args.graph, 200000) : null
  if (graphYaml) {
    // Debug preview to help troubleshoot prompt content
    const preview =
      graphYaml.length > 2000
        ? graphYaml.slice(0, 2000) + '\n# ...(truncated preview)\n'
        : graphYaml
    console.error('[visualize_code] GraphSnapshot YAML preview (first 2KB):\n' + preview)
  } else {
    console.error('[visualize_code] GraphSnapshot not provided')
  }
  const graphSection = graphYaml
    ? `\n\nGraphSnapshot YAML (may be truncated):\n\n\u003cGRAPH_YAML\u003e\n${graphYaml}\n\u003c/GRAPH_YAML\u003e\n`
    : '\n\nGraphSnapshot YAML: none available\n'

  const userInstruction = [
    args.title ? `Title: ${args.title}` : undefined,
    `Visualization prompt: ${args.message}`,
    graphSection,
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
    uri: `ui://ref-tools-mcp/visualize-code-${Date.now()}`,
    content: { type: 'rawHtml', htmlString: fullHtml },
    encoding: 'text',
  }) as unknown as any

  return { content: [uiResource] as any }
}

function ensureHtmlDocument(maybeHtml: string): string {
  const trimmed = (maybeHtml || '').trim()
  const hasHtmlTag = /<html[\s\S]*?>[\s\S]*<\/html>/i.test(trimmed)

  const resizeScript = `<script>
const resizeObserver = new ResizeObserver((entries) => {
  entries.forEach((entry) => {
    window.parent.postMessage(
      { type: "ui-size-change", payload: { height: entry.contentRect.height } },
      "*"
    );
  });
});
resizeObserver.observe(document.documentElement);
</script>`

  if (hasHtmlTag) {
    if (/<\/body>/i.test(trimmed)) return trimmed.replace(/<\/body>/i, `${resizeScript}</body>`)
    if (/<\/html>/i.test(trimmed)) return trimmed.replace(/<\/html>/i, `${resizeScript}</html>`)
    return trimmed + resizeScript
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin: 0; padding: 16px; }
      .container { max-width: 960px; margin: 0 auto; }
      header { margin-bottom: 12px; }
      h1 { font-size: 1.25rem; margin: 0 0 8px; }
      small { opacity: 0.7; }
      pre { white-space: pre-wrap; word-wrap: break-word; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="container">${trimmed}</div>
    ${resizeScript}
  </body>
</html>`
}

function safeYaml(obj: any, maxLen: number): string {
  try {
    const s = toYaml(obj)
    if (s.length <= maxLen) return s
    return s.slice(0, maxLen) + `\n# ...truncated ${s.length - maxLen} chars`
  } catch {
    return '# [unstringifiable graph]'
  }
}

function toYaml(value: any, indentLevel: number = 0, seen?: WeakSet<object>): string {
  const indent = '  '.repeat(indentLevel)
  const nextIndent = '  '.repeat(indentLevel + 1)
  const localSeen = seen || new WeakSet<object>()

  const type = typeof value
  if (value === null || value === undefined) return 'null'
  if (type === 'number' || type === 'bigint') return String(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => {
      const rendered = toYaml(item, indentLevel + 1, localSeen)
      const isMultiLine = /\n/.test(rendered)
      if (isMultiLine)
        return `${indent}- |\n${rendered
          .split('\n')
          .map((l) => `${indent}  ${l}`)
          .join('\n')}`
      return `${indent}- ${rendered}`
    })
    return items.join('\n')
  }

  if (type === 'object') {
    if (localSeen.has(value)) return '"[Circular]"'
    localSeen.add(value as object)
    const keys = Object.keys(value as object)
    if (keys.length === 0) return '{}'
    keys.sort()
    const lines: string[] = []
    for (const key of keys) {
      const v = (value as any)[key]
      const rendered = toYaml(v, indentLevel + 1, localSeen)
      const isPrimitive = !/\n/.test(rendered)
      if (isPrimitive) lines.push(`${indent}${key}: ${rendered}`)
      else {
        lines.push(`${indent}${key}:`)
        lines.push(
          rendered
            .split('\n')
            .map((l) => `${nextIndent}${l}`)
            .join('\n'),
        )
      }
    }
    return lines.join('\n')
  }

  return JSON.stringify(String(value))
}
