import { describe, it, expect } from 'vitest'
import { sendCdp, cdpRefusedMessage, type DebuggerLike } from './browser-cdp-send'
import type { CdpContext } from './browser-cdp-allowlist'

const ctx: CdpContext = { viewport: { width: 1280, height: 800 } }

function fakeDebugger(): DebuggerLike & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    isAttached: () => true,
    attach: () => {},
    detach: () => {},
    sendCommand: (method: string) => {
      sent.push(method)
      return Promise.resolve({ ok: true })
    },
    on: () => {}
  }
}

describe('sendCdp — the one gate every command passes', () => {
  it('an allowed command reaches the debugger', async () => {
    const dbg = fakeDebugger()
    await sendCdp(dbg, 'Page.navigate', { url: 'https://x.test/' }, ctx)
    expect(dbg.sent).toEqual(['Page.navigate'])
  })

  it('a refused command NEVER reaches the debugger, and rejects with a named message', async () => {
    const dbg = fakeDebugger()
    await expect(sendCdp(dbg, 'Runtime.evaluate', { expression: '1' }, ctx)).rejects.toThrow(
      cdpRefusedMessage('Runtime.evaluate')
    )
    // The refusal is a rejected promise, not a hang and not a silent drop.
    expect(dbg.sent).toEqual([])
  })

  it('a refused parameter is caught even on an allowed method', async () => {
    const dbg = fakeDebugger()
    await expect(sendCdp(dbg, 'Page.navigate', { url: 'javascript:alert(1)' }, ctx)).rejects.toThrow(
      /not permitted/
    )
    expect(dbg.sent).toEqual([])
  })
})
