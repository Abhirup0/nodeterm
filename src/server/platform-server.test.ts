import { describe, it, expect } from 'vitest'
import { ServerPlatform, type UiSink } from './platform-server'
import { E_NO_HANDLER } from '../shared/rpc'
import { decodePtyData } from '../shared/rpc'

function fakeSink() {
  const texts: string[] = []
  const bins: Uint8Array[] = []
  const sink: UiSink = { sendText: (j) => texts.push(j), sendBinary: (b) => bins.push(b) }
  return { sink, texts, bins }
}

describe('ServerPlatform', () => {
  it('dispatches req to handle and handleWithSender (sender = uiId)', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    p.handle('a:b', (n: number) => n + 1)
    p.handleWithSender('a:c', (sender: number, s: string) => `${sender}:${s}`)
    const { sink } = fakeSink()
    const ui = p.attach(sink)
    expect(await p.dispatch(ui, { t: 'req', id: 1, method: 'a:b', args: [41] })).toEqual({
      t: 'res', id: 1, ok: true, result: 42
    })
    expect(await p.dispatch(ui, { t: 'req', id: 2, method: 'a:c', args: ['x'] })).toEqual({
      t: 'res', id: 2, ok: true, result: `${ui}:x`
    })
  })

  it('unknown method → E_NO_HANDLER; throwing handler → E_HANDLER with message', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    p.handle('boom', () => { throw new Error('kapow') })
    const ui = p.attach(fakeSink().sink)
    const missing = await p.dispatch(ui, { t: 'req', id: 3, method: 'nope', args: [] })
    expect(missing).toMatchObject({ ok: false, error: { code: E_NO_HANDLER } })
    const thrown = await p.dispatch(ui, { t: 'req', id: 4, method: 'boom', args: [] })
    expect(thrown).toMatchObject({ ok: false, error: { code: 'E_HANDLER', message: 'kapow' } })
  })

  it('cast runs on-listeners and ignores unknown methods silently', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const got: unknown[] = []
    p.on('w', (a: string) => got.push(a))
    const ui = p.attach(fakeSink().sink)
    p.cast(ui, 'w', ['hello'])
    p.cast(ui, 'unknown', ['ignored'])
    expect(got).toEqual(['hello'])
  })

  it('sendTo routes pty:data as binary, other channels as JSON events, drops when detached', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const a = fakeSink()
    const ui = p.attach(a.sink)
    p.sendTo(ui, 'pty:data:s1', 'output')
    p.sendTo(ui, 'pty:exit:s1', 0)
    expect(decodePtyData(a.bins[0])).toEqual({ sessionId: 's1', data: 'output' })
    expect(JSON.parse(a.texts[0])).toEqual({ t: 'ev', channel: 'pty:exit:s1', args: [0] })
    p.detach(ui)
    p.sendTo(ui, 'pty:exit:s1', 1) // must not throw
    expect(a.texts).toHaveLength(1)
  })

  it('broadcast reaches every attached sink', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const a = fakeSink(); const b = fakeSink()
    p.attach(a.sink); p.attach(b.sink)
    p.broadcast('license:changed', { tier: 'x' })
    expect(a.texts).toHaveLength(1)
    expect(b.texts).toHaveLength(1)
  })

  it('exposes userDataDir/appVersion/isPackaged; openExternal rejects', async () => {
    const p = new ServerPlatform({ userDataDir: '/data', appVersion: '9.9.9' })
    expect(p.userDataDir).toBe('/data')
    expect(p.appVersion).toBe('9.9.9')
    expect(p.isPackaged).toBe(true)
    await expect(p.openExternal('https://x')).rejects.toThrow()
  })
})
