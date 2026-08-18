import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { checkCdpCommand, type CdpContext } from './browser-cdp-allowlist'
import { NT_SCRIPTS } from './browser-nt-scripts'

const ctx: CdpContext = { viewport: { width: 1280, height: 800 } }

describe('checkCdpCommand', () => {
  it('an allowlist keyed on METHOD NAME is not what this is', () => {
    // The danger in Runtime.evaluate is not its name, it is one parameter. So the list is
    // (method, params-validator) pairs — which is also what buys the URL check on Page.navigate
    // that a name-only list cannot express.
    expect(checkCdpCommand('Page.navigate', { url: 'https://x.test/' }, ctx)).toBe(true)
    expect(checkCdpCommand('Page.navigate', { url: 'javascript:alert(1)' }, ctx)).toBe(false)
    expect(checkCdpCommand('Page.navigate', { url: 'file:///etc/passwd' }, ctx)).toBe(false)
    expect(checkCdpCommand('Page.navigate', { url: 'data:text/html,<x>' }, ctx)).toBe(false)
  })

  it.each([
    'Runtime.evaluate', 'Runtime.compileScript', 'Runtime.runScript', 'Runtime.addBinding',
    'Debugger.enable', 'Debugger.setBreakpoint', 'Profiler.enable', 'Tracing.start',
    'Fetch.enable', 'Emulation.setUserAgentOverride', 'Storage.clearDataForOrigin',
    'Browser.close', 'Security.setIgnoreCertificateErrors',
    'IndexedDB.requestData', 'DOMStorage.getDOMStorageItems',
    'Network.getAllCookies', 'Page.bringToFront',
    'DOM.getOuterHTML', 'DOM.getAttributes', 'Input.synthesizeScrollGesture'
  ])('%s is refused', (m) => {
    expect(checkCdpCommand(m, {}, ctx)).toBe(false)
  })

  it('callFunctionOn requires IDENTITY with an NT_SCRIPTS entry and value-only arguments', () => {
    const ok = { objectId: 'o1', functionDeclaration: NT_SCRIPTS.readMap, arguments: [{ value: '#x' }], returnByValue: true }
    expect(checkCdpCommand('Runtime.callFunctionOn', ok, ctx)).toBe(true)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, functionDeclaration: 'function(){return 1}' }, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, arguments: [{ objectId: 'o2' }] }, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, arguments: [{ value: { a: 1 } }] }, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, returnByValue: false }, ctx)).toBe(false)
  })

  it('mouse coordinates must be inside the reported viewport', () => {
    expect(checkCdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: -1, y: 10 }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 99999, y: 10 }, ctx)).toBe(false)
  })

  it('selector length and DOM depth are bounded', () => {
    expect(checkCdpCommand('DOM.querySelector', { nodeId: 1, selector: 'a'.repeat(1024) }, ctx)).toBe(true)
    expect(checkCdpCommand('DOM.querySelector', { nodeId: 1, selector: 'a'.repeat(1025) }, ctx)).toBe(false)
    expect(checkCdpCommand('DOM.getDocument', { depth: 2 }, ctx)).toBe(false)
  })

  it('Input.insertText is capped', () => {
    expect(checkCdpCommand('Input.insertText', { text: 'x'.repeat(8192) }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.insertText', { text: 'x'.repeat(8193) }, ctx)).toBe(false)
  })

  it('cookie READS take one explicit domain; the jar-emptying call does not exist here', () => {
    expect(checkCdpCommand('Network.getCookies', { urls: ['https://github.com/'] }, ctx)).toBe(true)
    expect(checkCdpCommand('Network.getCookies', {}, ctx)).toBe(false)      // no domain ⇒ the whole jar
    expect(checkCdpCommand('Network.getAllCookies', {}, ctx)).toBe(false)
  })

  it('cookie WRITES are listed (owner decision 5) and unreachable in v1', () => {
    // The methods stay listed so the allowlist RECORDS the decision; PR 9 Task 9.4 pins that no
    // verb reaches them, because a write verb needs a design nobody has done: where does the agent
    // get the value, and what stops it planting accounts.google.com so a later human visit is a
    // login the attacker controls?
    expect(checkCdpCommand('Network.setCookie', { name: 'a', value: 'b', domain: 'x.test' }, ctx)).toBe(true)
  })

  it('an unknown method is refused with NO per-method detail', () => {
    // An allowlist that explains itself is a probing aid.
    expect(checkCdpCommand('Made.Up', {}, ctx)).toBe(false)
  })
})

/**
 * Structural pin (the analogue of Task 4.4's second half). `checkCdpCommand` is only THE gate if it
 * is unbypassable: every `sendCommand(` in the main-side browser surface must live inside the one
 * wrapper, `browser-cdp-send.ts`, which calls this function. A direct `debugger.sendCommand` anywhere
 * else is arbitrary CDP that never met the allowlist.
 */
describe('debugger.sendCommand has exactly one call site', () => {
  const mainDir = path.resolve(__dirname)

  it('every sendCommand( in src/main/browser-*.ts is inside browser-cdp-send.ts', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(mainDir)) {
      if (!/^browser-.*\.ts$/.test(f) || f.endsWith('.test.ts')) continue
      if (f === 'browser-cdp-send.ts') continue
      const src = fs.readFileSync(path.join(mainDir, f), 'utf8')
      // Strip comments so a mention in prose is not a false positive; a real call is not a comment.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      if (/\bsendCommand\s*\(/.test(code)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
