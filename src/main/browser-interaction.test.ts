import { describe, it, expect } from 'vitest'
import { BrowserSession } from './browser-lease'
import type { DebuggerLike } from './browser-cdp-send'
import type { CdpContext } from './browser-cdp-allowlist'
import { NT_SCRIPTS } from './browser-nt-scripts'
import { RefTable, type RefItem } from './browser-refs'
import {
  browserClick,
  browserType,
  browserPress,
  browserScroll,
  browserWait,
  browserReadMap,
  type Driver
} from './browser-actions'

/**
 * The PR 8 interaction verbs, driven through the REAL production stack — a real {@link BrowserSession},
 * real `sendCdp`, the real CDP allowlist and the real frozen NT_SCRIPTS — against a fake
 * `webContents.debugger` that returns canned page data and applies a wheel event to a mutable scroll
 * offset. So EVERY command an action issues actually passes the allowlist gate: a method that were not
 * allowlisted, or a bad-params send, would reject and fail the test. That is the security spine under
 * test — the same one PR 7 established — and the click/type/press/scroll verbs all drive through it.
 *
 * The readers' in-page behaviour (a real <webview>) is deferred with the rest of the pointer harness
 * (Global Constraint 8) — headless, no display; see the --scroll probe doc.
 */

interface FakePage {
  width: number
  height: number
  scrollY: number
  contentHeight: number
  refCoords: Record<number, { x: number; y: number; tag: string } | null>
  selectorCoords: Record<string, { x: number; y: number; tag: string } | null>
  activeField: { tag: string; id: string } | null
  visible: Record<string, boolean>
  mapItems: RefItem[]
}

class FakeDebugger implements DebuggerLike {
  attached = false
  attachCount = 0
  sends: { method: string; params: Record<string, unknown> }[] = []
  private det: ((e: unknown, reason: string) => void)[] = []

  constructor(public page: FakePage) {}

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
    this.attachCount++
  }
  detach(): void {
    this.attached = false
    for (const f of this.det) f({}, 'user')
  }
  on(event: 'detach' | 'message', listener: never): void {
    if (event === 'detach') this.det.push(listener)
  }
  async sendCommand(method: string, params: object = {}): Promise<unknown> {
    const p = params as Record<string, unknown>
    this.sends.push({ method, params: p })
    switch (method) {
      case 'Page.getLayoutMetrics':
        return {
          cssLayoutViewport: { clientWidth: this.page.width, clientHeight: this.page.height },
          cssVisualViewport: { clientWidth: this.page.width, clientHeight: this.page.height, pageX: 0, pageY: this.page.scrollY },
          cssContentSize: { width: this.page.width, height: this.page.contentHeight }
        }
      case 'DOM.getDocument':
        return { root: { nodeId: 1 } }
      case 'DOM.resolveNode':
        return { object: { objectId: 'doc-obj' } }
      case 'Runtime.callFunctionOn':
        return { result: { value: this.evalReader(p) } }
      case 'Input.dispatchMouseEvent': {
        if (p.type === 'mouseWheel') {
          const max = Math.max(0, this.page.contentHeight - this.page.height)
          this.page.scrollY = Math.min(Math.max(0, this.page.scrollY + (p.deltaY as number)), max)
        }
        return {}
      }
      default:
        return {}
    }
  }

  private evalReader(p: Record<string, unknown>): unknown {
    const fn = p.functionDeclaration
    const args = (p.arguments as { value: unknown }[] | undefined) ?? []
    if (fn === NT_SCRIPTS.readMap) return this.page.mapItems
    if (fn === NT_SCRIPTS.resolveRef) return this.page.refCoords[args[0]?.value as number] ?? null
    if (fn === NT_SCRIPTS.resolveSelector) return this.page.selectorCoords[args[0]?.value as string] ?? null
    if (fn === NT_SCRIPTS.activeField) return this.page.activeField
    if (fn === NT_SCRIPTS.isVisible) return this.page.visible[args[0]?.value as string] === true
    return null
  }
}

const NODE = 'browser-3'

function basePage(over: Partial<FakePage> = {}): FakePage {
  return {
    width: 1000,
    height: 800,
    scrollY: 0,
    contentHeight: 4400,
    refCoords: {},
    selectorCoords: {},
    activeField: null,
    visible: {},
    mapItems: [],
    ...over
  }
}

function make(page: FakePage): { s: Driver; dbg: FakeDebugger; refs: RefTable } {
  const dbg = new FakeDebugger(page)
  // The injected viewport is the 0×0 placeholder — refreshViewport() must override it, exactly as in
  // production. If it did not, every bounded click would be refused.
  const viewport = (): CdpContext => ({ viewport: { width: 0, height: 0 } })
  const session = new BrowserSession({ nodeId: NODE, debugger: dbg, viewport })
  return { s: session as unknown as Driver, dbg, refs: new RefTable() }
}

const mouseEvents = (dbg: FakeDebugger): Record<string, unknown>[] =>
  dbg.sends.filter((x) => x.method === 'Input.dispatchMouseEvent').map((x) => x.params)
const keyEvents = (dbg: FakeDebugger): Record<string, unknown>[] =>
  dbg.sends.filter((x) => x.method === 'Input.dispatchKeyEvent').map((x) => x.params)

const MAP = [
  { ref: 0, tag: 'button', role: 'button', id: '', type: null, name: 'Sign in', href: null, filled: null },
  { ref: 1, tag: 'input', role: 'input', id: 'email', type: 'email', name: '', href: null, filled: false }
] as RefItem[]

// ── 8.1 --click ─────────────────────────────────────────────────────────────────────────────────
describe('--click', () => {
  it('clicks a @ref at its current centre and names WHAT was clicked (not a coordinate)', async () => {
    const page = basePage({ mapItems: MAP, refCoords: { 0: { x: 500, y: 100, tag: 'BUTTON' } } })
    const { s, dbg, refs } = make(page)
    await browserReadMap(s, refs, NODE) // mint @1,@2
    const r = await browserClick(s, refs, NODE, '@1')
    expect(r).toEqual({ ok: true, message: 'clicked @1 (button "Sign in") on browser-3' })
    const me = mouseEvents(dbg)
    expect(me.map((e) => e.type)).toEqual(['mousePressed', 'mouseReleased'])
    expect(me[0]).toMatchObject({ x: 500, y: 100, button: 'left' })
  })

  it('clicks a raw CSS selector too (the derived-handle escape hatch)', async () => {
    const page = basePage({ selectorCoords: { '#submit': { x: 400, y: 300, tag: 'BUTTON' } } })
    const { s, refs } = make(page)
    const r = await browserClick(s, refs, NODE, '#submit')
    expect(r).toEqual({ ok: true, message: 'clicked #submit (button) on browser-3' })
  })

  it('a stale @ref (page navigated since the map) is REFUSED and dispatches NO click (PR 5)', async () => {
    const page = basePage({ mapItems: MAP, refCoords: { 0: { x: 500, y: 100, tag: 'BUTTON' } } })
    const { s, dbg, refs } = make(page)
    await browserReadMap(s, refs, NODE)
    refs.bumpGeneration(NODE) // Page.frameNavigated
    const r = await browserClick(s, refs, NODE, '@1')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('the page navigated since the last --read map')
    expect(mouseEvents(dbg)).toEqual([]) // never clicked a re-resolved element
  })

  it('an off-screen target is refused and dispatches NO click', async () => {
    const page = basePage({ mapItems: MAP, refCoords: { 0: { x: 5000, y: 100, tag: 'BUTTON' } } })
    const { s, dbg, refs } = make(page)
    await browserReadMap(s, refs, NODE)
    const r = await browserClick(s, refs, NODE, '@1')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('off-screen')
    expect(mouseEvents(dbg)).toEqual([])
  })

  it('a selector matching nothing is a named refusal', async () => {
    const { s, refs } = make(basePage())
    const r = await browserClick(s, refs, NODE, '#missing')
    expect(r).toEqual({ ok: false, message: 'browser: nothing matches #missing on browser-3' })
  })
})

// ── 8.2 --type ──────────────────────────────────────────────────────────────────────────────────
describe('--type', () => {
  const SECRET = 'S3CR3T-pw'

  it('focuses --into and inserts the text — the reply reports the COUNT, never the text', async () => {
    const page = basePage({ mapItems: MAP, refCoords: { 1: { x: 500, y: 200, tag: 'INPUT' } } })
    const { s, dbg, refs } = make(page)
    await browserReadMap(s, refs, NODE)
    const r = await browserType(s, refs, NODE, { text: SECRET, into: '@2', clear: false })
    expect(r).toEqual({ ok: true, message: 'typed 9 chars into @2 (input#email) on browser-3' })
    // The typed text is NEVER echoed anywhere in the reply.
    expect(r.message).not.toContain(SECRET)
    // It went to insertText (data), not to any expression/key event.
    const inserts = dbg.sends.filter((x) => x.method === 'Input.insertText')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params).toEqual({ text: SECRET })
    // Focused the field the way a user does.
    expect(mouseEvents(dbg).map((e) => e.type)).toEqual(['mousePressed', 'mouseReleased'])
  })

  it('--clear true selects the field before inserting', async () => {
    const page = basePage({ mapItems: MAP, refCoords: { 1: { x: 500, y: 200, tag: 'INPUT' } } })
    const { s, dbg, refs } = make(page)
    await browserReadMap(s, refs, NODE)
    const r = await browserType(s, refs, NODE, { text: 'hi', into: '@2', clear: true })
    expect(r.message).toBe('typed 2 chars into @2 (input#email) on browser-3')
    expect(keyEvents(dbg).some((e) => Array.isArray(e.commands) && (e.commands as string[]).includes('selectAll'))).toBe(true)
  })

  it('--clear with empty text clears the field and says so (no insert)', async () => {
    const page = basePage({ mapItems: MAP, refCoords: { 1: { x: 500, y: 200, tag: 'INPUT' } } })
    const { s, dbg, refs } = make(page)
    await browserReadMap(s, refs, NODE)
    const r = await browserType(s, refs, NODE, { text: '', into: '@2', clear: true })
    expect(r).toEqual({ ok: true, message: 'cleared @2 (input#email) on browser-3' })
    expect(dbg.sends.some((x) => x.method === 'Input.insertText')).toBe(false)
    const cmds = keyEvents(dbg).flatMap((e) => (Array.isArray(e.commands) ? (e.commands as string[]) : []))
    expect(cmds).toEqual(['selectAll', 'deleteBackward'])
  })

  it('no --into and NOTHING focused is the exact named refusal', async () => {
    const { s, refs } = make(basePage({ activeField: null }))
    const r = await browserType(s, refs, NODE, { text: 'x', clear: false })
    expect(r).toEqual({ ok: false, message: 'browser: --type needs --into, or a focused field (nothing is focused)' })
  })

  it('no --into but a field IS focused: types into it with no click', async () => {
    const page = basePage({ activeField: { tag: 'input', id: 'email' } })
    const { s, dbg, refs } = make(page)
    const r = await browserType(s, refs, NODE, { text: SECRET, clear: false })
    expect(r).toEqual({ ok: true, message: 'typed 9 chars into the focused input#email on browser-3' })
    expect(r.message).not.toContain(SECRET)
    expect(mouseEvents(dbg)).toEqual([]) // nothing to focus — no click
  })
})

// ── 8.3 --press ─────────────────────────────────────────────────────────────────────────────────
describe('--press', () => {
  it('Enter is a keyDown+keyUp from the fixed table', async () => {
    const { s, dbg } = make(basePage())
    const r = await browserPress(s, NODE, 'Enter', 1)
    expect(r).toEqual({ ok: true, message: 'pressed Enter on browser-3' })
    const ke = keyEvents(dbg)
    expect(ke.map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(ke[0]).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13 })
  })

  it('--times repeats and is reported', async () => {
    const { s, dbg } = make(basePage())
    const r = await browserPress(s, NODE, 'ArrowDown', 3)
    expect(r.message).toBe('pressed ArrowDown x3 on browser-3')
    expect(keyEvents(dbg)).toHaveLength(6) // 3 × (down+up)
  })

  it('--times is capped so one verb cannot fire an unbounded storm', async () => {
    const { s, dbg } = make(basePage())
    const r = await browserPress(s, NODE, 'PageDown', 100)
    expect(r.message).toBe('pressed PageDown x50 on browser-3')
    expect(keyEvents(dbg)).toHaveLength(100)
  })
})

// ── 8.4 --scroll ────────────────────────────────────────────────────────────────────────────────
describe('--scroll', () => {
  it('scrolls via a bounded mouseWheel and reports the ACTUAL delta read back, not the requested one', async () => {
    const page = basePage({ scrollY: 0, height: 800, contentHeight: 4400 })
    const { s, dbg } = make(page)
    const r = await browserScroll(s, NODE, 'down')
    // 0.9 × 800 = 720 requested; the fake applied it; the reply is the MEASURED result.
    expect(r).toEqual({ ok: true, message: 'scrolled browser-3 down 720px (at 720/4400)' })
    const wheel = mouseEvents(dbg).find((e) => e.type === 'mouseWheel')
    expect(wheel).toMatchObject({ x: 500, y: 400, deltaY: 720 }) // centre of the viewport
  })

  it('a signed pixel count matches the design example shape', async () => {
    const { s } = make(basePage({ scrollY: 0, height: 800, contentHeight: 4400 }))
    const r = await browserScroll(s, NODE, '600')
    expect(r.message).toBe('scrolled browser-3 down 600px (at 600/4400)')
  })

  it('a scroll that MOVES NOTHING shows as 0px — the worst failure shape cannot hide', async () => {
    // A page no taller than the viewport cannot scroll: the reply must make that visible.
    const { s } = make(basePage({ scrollY: 0, height: 800, contentHeight: 800 }))
    const r = await browserScroll(s, NODE, 'down')
    expect(r.message).toBe('scrolled browser-3 0px (at 0/800)')
  })
})

// ── 8.5 --wait ──────────────────────────────────────────────────────────────────────────────────
describe('--wait', () => {
  it('a selector already visible returns at once, naming the wait', async () => {
    const { s, refs } = make(basePage({ visible: { '#results': true } }))
    const r = await browserWait(s, refs, NODE, '#results', 15_000, { now: () => 0, sleep: async () => {} })
    expect(r).toEqual({ ok: true, message: '#results appeared on browser-3 after 0ms' })
  })

  it('a timeout is a NAMED refusal on our own clock', async () => {
    let clock = 0
    const now = (): number => clock
    const sleep = async (ms: number): Promise<void> => {
      clock += ms
    }
    const { s, refs } = make(basePage({ visible: { '#results': false } }))
    const r = await browserWait(s, refs, NODE, '#results', 300, { now, sleep })
    expect(r).toEqual({ ok: false, message: 'browser: #results did not appear on browser-3 within 300ms' })
  })

  it('reports how long a selector took to appear', async () => {
    const page = basePage({ visible: { '#late': false } })
    let clock = 0
    const now = (): number => clock
    const sleep = async (ms: number): Promise<void> => {
      clock += ms
      if (clock >= 300) page.visible['#late'] = true // appears mid-wait
    }
    const { s, refs } = make(page)
    const r = await browserWait(s, refs, NODE, '#late', 15_000, { now, sleep })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/^#late appeared on browser-3 after \d+ms$/)
  })
})
