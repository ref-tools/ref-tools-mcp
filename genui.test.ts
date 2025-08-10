import { describe, it, expect } from 'vitest'
import { ensureHtmlDocument } from './genui'

describe('ensureHtmlDocument', () => {
  it('wraps partial HTML and injects resize script with MIN_HEIGHT=640 and CSS min-height', () => {
    const out = ensureHtmlDocument('<div>Hello</div>')
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('MIN_HEIGHT = 640')
    expect(out).toContain('type: "ui-size-change"')
    expect(out).toContain('setTimeout(() => postHeight(MIN_HEIGHT), 60)')
    // CSS min-height applied to body/container
    expect(out).toContain('body {')
    expect(out).toContain('min-height: 640px;')
    expect(out).toContain('.container {')
    expect(out).toContain('min-height: 640px;')
  })

  it('injects resize script into full HTML documents', () => {
    const html = '<html><body><div>Hi</div></body></html>'
    const out = ensureHtmlDocument(html)
    expect(out).toContain('MIN_HEIGHT = 640')
    expect(out).toContain('postMessage')
    // Ensures runtime min-height enforcement for full HTML via JS
    expect(out).toContain("document.documentElement.style.minHeight = MIN_HEIGHT + 'px'")
  })
})
