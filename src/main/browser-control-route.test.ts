import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveBrowserTarget,
  browserResolveTimedOut,
  type BrowserResolve
} from './browser-drive'

/**
 * Task 7.2 — `browser` is answered in MAIN, and the renderer only says what it alone knows. The
 * security decision (owner + capability + the CDP allowlist) is main-side; the renderer is asked
 * three facts and NEVER runs a CDP command. These tests pin both halves: the resolve round-trip
 * cannot hang the pending-control budget, and the renderer half holds no CDP surface.
 */

const repoRoot = path.resolve(__dirname, '..', '..')

describe('the resolve round-trip is a NAMED failure, never a hang (does not eat the 120s budget)', () => {
  it('a canvas that never answers times out to a named refusal well under the budget', async () => {
    const never = () => new Promise<BrowserResolve>(() => {}) // hangs forever
    const start = Date.now()
    const r = await resolveBrowserTarget('browser-3', never, 30)
    expect(Date.now() - start).toBeLessThan(1000)
    expect(r).toEqual({ ok: false, refusal: browserResolveTimedOut('browser-3') })
  })

  it('a renderer that rejects (the window went away) is the same named failure', async () => {
    const rejects = () => Promise.reject(new Error('window gone'))
    const r = await resolveBrowserTarget('browser-3', rejects, 1000)
    expect(r).toEqual({ ok: false, refusal: browserResolveTimedOut('browser-3') })
  })

  it('a prompt answer is passed straight through', async () => {
    const answer: BrowserResolve = { ok: true, projectId: 'p', sourceControlCapable: true, capabilityOn: true }
    const r = await resolveBrowserTarget('browser-3', () => Promise.resolve(answer), 1000)
    expect(r).toEqual(answer)
  })
})

describe("Canvas.tsx holds NO part of the CDP surface (it is the more attackable half)", () => {
  const canvas = fs.readFileSync(path.join(repoRoot, 'src/renderer/canvas/Canvas.tsx'), 'utf8')
  // Strip comments so a mention in prose is not a false positive.
  const code = canvas.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('never calls sendCommand', () => {
    expect(/\bsendCommand\s*\(/.test(code)).toBe(false)
  })

  it('never imports the NT_SCRIPTS table', () => {
    expect(code.includes('browser-nt-scripts')).toBe(false)
    expect(/\bNT_SCRIPTS\b/.test(code)).toBe(false)
  })

  it('never imports the CDP allowlist', () => {
    expect(code.includes('browser-cdp-allowlist')).toBe(false)
    expect(code.includes('browser-cdp-send')).toBe(false)
    expect(/\bcheckCdpCommand\b/.test(code)).toBe(false)
  })

  it('never imports the main-side drive/gate module', () => {
    // The allowlist and the ledger must not be reachable from the renderer at all.
    expect(code.includes('browser-drive')).toBe(false)
    expect(code.includes('browser-control-ledger')).toBe(false)
  })
})

/**
 * Carried obligation (PR 6/#307 MINOR-1): there is NO second global browser-control toggle — the ONLY
 * gate is the per-project switch (`agentBrowserControl`). A machine-wide "browser control on/off"
 * setting would be a second, coarser authority that could silently override the per-project consent
 * the whole design is built on. This was true by grep but unguarded; here it is pinned.
 */
describe('there is exactly ONE browser-control gate — the per-project switch, no second global toggle', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, out)
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(full)
    }
    return out
  }

  it('no settings/store key names a GLOBAL browser-control toggle', () => {
    // A global toggle would surface as a settings key like these. The per-project field is
    // `agentBrowserControl` (a project.json field), which is deliberately NOT matched here.
    const globalTogglePatterns = [
      /browserControlEnabled/i,
      /enableBrowserControl/i,
      /globalBrowserControl/i,
      /browserControlGlobal/i,
      /allowBrowserControl/i,
      /disableBrowserControl/i
    ]
    const offenders: string[] = []
    for (const f of walk(path.join(repoRoot, 'src'))) {
      const src = fs.readFileSync(f, 'utf8')
      for (const re of globalTogglePatterns) {
        if (re.test(src)) offenders.push(`${path.relative(repoRoot, f)} :: ${re}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
