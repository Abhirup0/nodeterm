// The reconnect overlay must show on an initial-connect failure (server down at page load), not
// just on a later drop. These tests exercise the exported overlay helpers directly.
//
// NOTE: the vitest suite here runs in the `node` environment (no jsdom/happy-dom is installed in
// this repo), so we mount a tiny in-memory DOM stub covering exactly the surface the overlay code
// touches (createElement / setAttribute / style.cssText / getElementById / body.appendChild /
// querySelector). This keeps the test hermetic without adding a DOM dependency.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { showReconnectOverlay, isOverlayMounted } from './ws-bridge'

interface StubEl {
  id: string
  textContent: string
  style: { cssText: string; position: string }
  attrs: Record<string, string>
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
}

function makeEl(): StubEl {
  const el: StubEl = {
    id: '',
    textContent: '',
    style: {
      cssText: '',
      get position(): string {
        const m = /(?:^|;)position:([^;]+)/.exec(el.style.cssText)
        return m ? m[1].trim() : ''
      }
    } as StubEl['style'],
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null
    }
  }
  return el
}

let children: StubEl[]

beforeEach(() => {
  children = []
  ;(globalThis as Record<string, unknown>).document = {
    createElement: () => makeEl(),
    getElementById: (id: string) => children.find((c) => c.id === id) ?? null,
    body: { appendChild: (el: StubEl) => children.push(el) },
    querySelector: (sel: string) => {
      const attr = /^\[([^\]]+)\]$/.exec(sel)?.[1]
      if (!attr) return null
      return children.find((c) => c.getAttribute(attr) !== null) ?? null
    }
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document
})

describe('reconnect overlay', () => {
  it('mounts a fixed full-screen overlay with the reconnect message', () => {
    expect(isOverlayMounted()).toBe(false)
    showReconnectOverlay()
    expect(isOverlayMounted()).toBe(true)
    const el = (globalThis.document as unknown as { querySelector(s: string): StubEl | null }).querySelector(
      '[data-nt-reconnect]'
    )
    expect(el).toBeTruthy()
    expect(el!.style.position).toBe('fixed')
    expect(el!.textContent).toMatch(/reconnect/i)
  })

  it('is idempotent — a second call does not mount a duplicate', () => {
    showReconnectOverlay()
    showReconnectOverlay()
    expect(children.filter((c) => c.getAttribute('data-nt-reconnect') !== null).length).toBe(1)
  })
})
