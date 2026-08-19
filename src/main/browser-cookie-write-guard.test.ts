import { describe, it, expect, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { driveBrowser, type BrowserResolve, type DriveDeps, type LiveGuest } from './browser-drive'
import { CdpEventBus, type Driver, type LayoutMetrics } from './browser-actions'
import { COOKIE_WRITE_METHODS } from './browser-cdp-allowlist'
import { BrowserControlLedger } from './browser-control-ledger'
import { RefTable } from './browser-refs'
import { BROWSER_ACTION_KEYS, parseBrowserArgs, type BrowserCall } from '../core/browser-verb'

const OWNER = 'claude-1'
const NODE = 'browser-3'

const okResolve: BrowserResolve = {
  ok: true,
  projectId: 'proj-1',
  projectCwd: '/proj',
  sourceControlCapable: true,
  capabilityOn: true,
  sourceTitle: 'claude-1',
  browserTitle: 'browser-3'
}

/** A Driver that RECORDS every method it is asked to send — INTENT, before any allowlist — and
 *  answers generically so each action runs far enough to emit its full method set. */
function recordingGuest(): { guest: LiveGuest; sent: string[] } {
  const sent: string[] = []
  const m: LayoutMetrics = { width: 800, height: 600, scrollX: 0, scrollY: 0, contentWidth: 800, contentHeight: 2000 }
  const session: Driver = {
    async send(method) {
      sent.push(method)
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } }
        case 'DOM.resolveNode':
          return { object: { objectId: 'o' } }
        case 'Runtime.callFunctionOn':
          // Satisfy the readers that need coordinates AND the ones that need a value; a superset object.
          return { result: { value: { x: 10, y: 10, tag: 'button', text: 'ok' } } }
        case 'Page.getNavigationHistory':
          return { currentIndex: 0, entries: [{ url: 'https://x.test/' }] }
        case 'Page.captureScreenshot':
          return { data: Buffer.from('PNG').toString('base64') }
        case 'Network.getCookies':
          return { cookies: [] }
        case 'Page.getLayoutMetrics':
          return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, cssContentSize: { width: 800, height: 2000 } }
        default:
          return {}
      }
    },
    async refreshViewport() {
      return m
    }
  }
  return { guest: { session, bus: new CdpEventBus() }, sent }
}

function ledgerOwning(): BrowserControlLedger {
  const l = new BrowserControlLedger()
  l.claim(NODE, { ownerNodeId: OWNER, projectId: 'proj-1', partition: 'p', navGeneration: 0, leaseActiveUntil: 0, openedAt: 0 })
  return l
}

/** One representative call per action key — the whole action surface parseBrowserArgs admits. */
function callFor(action: string): BrowserCall {
  const base: Record<string, string> = { node: NODE, timeout: '10' }
  const args: Record<string, Record<string, string>> = {
    nav: { ...base, nav: 'https://x.test/' },
    read: { ...base, read: 'map' },
    click: { ...base, click: '#go' },
    type: { ...base, type: 'hello', into: '#f' },
    press: { ...base, press: 'Enter' },
    scroll: { ...base, scroll: 'down' },
    wait: { ...base, wait: '#done' },
    screenshot: { ...base, screenshot: 'shot.png' },
    cookies: { ...base, cookies: 'github.com' }
  }
  const parsed = parseBrowserArgs(args[action])
  if ('error' in parsed) throw new Error(`could not build a call for ${action}: ${parsed.error}`)
  return parsed
}

describe('Task 9.4 — no verb reaches a cookie WRITE (the set is listed & unreachable)', () => {
  it('enumerates every action and records the CDP methods each emits; the write intersection is empty', async () => {
    // A real project dir so the screenshot jail resolves; writeFile is a no-op spy.
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'guard-'))
    const screenshotIO = {
      realpath: (p: string) => fsp.realpath(p),
      lstat: (p: string) => fsp.lstat(p),
      writeFile: vi.fn(async () => {})
    }
    const resolve: BrowserResolve = { ...okResolve, projectCwd: project }

    const emittedByAction: Record<string, string[]> = {}
    for (const action of BROWSER_ACTION_KEYS) {
      const { guest, sent } = recordingGuest()
      const deps: DriveDeps = {
        ledger: ledgerOwning(),
        refs: new RefTable(),
        sessionFor: () => guest,
        revoke: vi.fn(),
        appendBoardLog: async () => true, // the cookie trace succeeds so the read is reached
        screenshotIO
      }
      await driveBrowser({ call: callFor(action), ownerNodeId: OWNER, verified: true, resolve }, deps)
      emittedByAction[action] = sent
    }

    // Every action was actually exercised (a new action can't be added without appearing here).
    expect(Object.keys(emittedByAction).sort()).toEqual([...BROWSER_ACTION_KEYS].sort())

    // The union of everything any verb emits, intersected with the write set, must be empty.
    const writeSet = new Set<string>(COOKIE_WRITE_METHODS)
    const allEmitted = new Set<string>(Object.values(emittedByAction).flat())
    const reachableWrites = [...allEmitted].filter((m) => writeSet.has(m))
    expect(reachableWrites).toEqual([])

    // And, positively: the cookie READ path DID reach getCookies (so the emptiness above is not just
    // because nothing ran).
    expect(emittedByAction.cookies).toContain('Network.getCookies')

    await fsp.rm(project, { recursive: true, force: true })
  })
})
