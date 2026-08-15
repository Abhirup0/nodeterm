// The guard main did not have: `browserGuests` stored whatever integer arrived over IPC. Every
// case below is a renderer-supplied value, because the renderer is the attackable half of this
// boundary — a compromised or merely buggy one must not be able to nominate the app's own window.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  browserDiscardedMessage,
  registerBrowserGuest,
  type BrowserGuest,
  type BrowserSurfaceKind
} from './browser-guest-registry'

const lookup =
  (types: Record<number, string>) =>
  (id: number): { getType: () => string } | null =>
    types[id] ? { getType: () => types[id] } : null

describe('registerBrowserGuest', () => {
  it('stores a real webview guest', () => {
    const m = new Map<number, BrowserGuest>()
    expect(registerBrowserGuest(m, 7, 'browser-1', 'canvas', lookup({ 7: 'webview' }))).toBe(true)
    expect(m.get(7)).toEqual({ nodeId: 'browser-1', surface: 'canvas' })
  })

  it('REFUSES an id naming the app window — this is the escalation the guard exists for', () => {
    const m = new Map<number, BrowserGuest>()
    expect(registerBrowserGuest(m, 1, 'browser-1', 'canvas', lookup({ 1: 'window' }))).toBe(false)
    expect(m.size).toBe(0)
  })

  it('refuses every non-webview type Electron can hand back, not just `window`', () => {
    const m = new Map<number, BrowserGuest>()
    for (const type of ['window', 'browserView', 'remote', 'backgroundPage', 'offscreen']) {
      expect(registerBrowserGuest(m, 5, 'browser-1', 'canvas', lookup({ 5: type })), type).toBe(
        false
      )
    }
    expect(m.size).toBe(0)
  })

  it('refuses an id that names nothing at all', () => {
    const m = new Map<number, BrowserGuest>()
    expect(registerBrowserGuest(m, 99, 'browser-1', 'canvas', lookup({}))).toBe(false)
    expect(m.size).toBe(0)
  })

  it('refuses a lookup that throws — a destroyed id is not a guest', () => {
    const m = new Map<number, BrowserGuest>()
    const throwing = (): never => {
      throw new Error('Object has been destroyed')
    }
    expect(registerBrowserGuest(m, 7, 'browser-1', 'canvas', throwing)).toBe(false)
    expect(m.size).toBe(0)
  })

  it('refuses an id that is not a positive integer, before it ever reaches the lookup', () => {
    const m = new Map<number, BrowserGuest>()
    // A lookup that would happily call ANYTHING a webview: the id guard is the only thing under
    // test here, so nothing else may be doing the refusing.
    let lookups = 0
    const anything = (): { getType: () => string } => {
      lookups += 1
      return { getType: () => 'webview' }
    }
    for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(registerBrowserGuest(m, id, 'browser-1', 'canvas', anything), `${id}`).toBe(false)
    }
    expect(m.size).toBe(0)
    expect(lookups).toBe(0)
  })

  it('refuses a node id `isSafeNodeId` refuses — it is a map key and, later, a storage key', () => {
    const m = new Map<number, BrowserGuest>()
    for (const bad of ['../etc', '', '.', '..', 'a/b', 'a b', 'x'.repeat(200)]) {
      expect(registerBrowserGuest(m, 7, bad, 'canvas', lookup({ 7: 'webview' })), bad).toBe(false)
    }
    expect(m.size).toBe(0)
  })

  it('refuses a surface value that is present and unrecognised', () => {
    const m = new Map<number, BrowserGuest>()
    // The renderer is the more attackable half; `surface` is what selects a debugger target later.
    for (const bad of ['modal ', 'CANVAS', '', null, 1]) {
      expect(
        registerBrowserGuest(m, 7, 'browser-1', bad as unknown as BrowserSurfaceKind, lookup({ 7: 'webview' })),
        String(bad)
      ).toBe(false)
    }
    expect(m.size).toBe(0)
  })

  it('records an ABSENT surface as unknown — never as canvas', () => {
    // Both mount sites still call the 2-argument preload, so this is what every registration in
    // the app looks like today. Defaulting to 'canvas' would file the kanban modal's guest as a
    // canvas guest: a false claim, indistinguishable from the real thing, and two 'canvas' entries
    // for one node id — the exact collision the field exists to prevent.
    const m = new Map<number, BrowserGuest>()
    expect(registerBrowserGuest(m, 7, 'browser-1', undefined, lookup({ 7: 'webview' }))).toBe(true)
    const guest = m.get(7)
    expect(guest?.nodeId).toBe('browser-1')
    expect(guest?.surface).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(guest, 'surface')).toBe(false)
  })

  it('accepts the modal surface, and keeps both of a node`s guests apart', () => {
    const m = new Map<number, BrowserGuest>()
    expect(registerBrowserGuest(m, 11, 'browser-3', 'modal', lookup({ 11: 'webview' }))).toBe(true)
    expect(registerBrowserGuest(m, 12, 'browser-3', 'canvas', lookup({ 12: 'webview' }))).toBe(true)
    expect(m.get(11)).toEqual({ nodeId: 'browser-3', surface: 'modal' })
    expect(m.get(12)).toEqual({ nodeId: 'browser-3', surface: 'canvas' })
  })
})

describe('browserDiscardedMessage', () => {
  it('names the memory saver rather than reading as a permissions failure', () => {
    const msg = browserDiscardedMessage('browser-3')
    expect(msg).toContain('browser-3')
    expect(msg).toContain('memory')
    // The rule it exists for: never blame permissions for a lifecycle event. "not drivable" would
    // send the next debugger to the identity code for a bug in browser-discard-policy.ts.
    expect(msg).not.toContain('drivable')
    expect(msg).not.toMatch(/refus|permission|identity|token/i)
    // It also has to say what to DO — a message with no way out is a dead end for the agent.
    expect(msg).toContain('bring it on screen')
    // Single line: every control reply is rendered as one.
    expect(msg).not.toContain('\n')
  })
})

/**
 * The guard is only worth anything if it is on the path. `ipcMain.on` cannot be exercised without
 * Electron, so this one claim — every write to `browserGuests` goes through the guard — is checked
 * against the source. It is the failure a pure unit test cannot see: a guard nobody calls.
 */
describe('the IPC handler is wired through it', () => {
  it('main never writes to browserGuests directly', () => {
    const src = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('registerBrowserGuest(browserGuests')
    // `.set(` anywhere on this map would be a second, unguarded door.
    expect(src).not.toContain('browserGuests.set(')
  })

  it('passes the surface through, absent and all — no default at the boundary either', () => {
    // The unit test above pins the registry; this pins the caller. A `surface ?? 'canvas'` here
    // would reintroduce the false claim one layer up, where no unit test can see it.
    const src = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('nodeId, surface, (id)')
    expect(src).not.toMatch(/surface\s*(\?\?|\|\|)/)
  })
})
