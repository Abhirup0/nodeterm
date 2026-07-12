import { describe, it, expect } from 'vitest'
import { buildPresenceApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'
import { PRESENCE_COLORS } from '../../shared/presence'

function fakeClient() {
  const subs: Array<{ channel: string }> = []
  const casts: Array<{ method: string; args: unknown[] }> = []
  const requests: Array<{ method: string; args: unknown[] }> = []
  return {
    subs,
    casts,
    requests,
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      subs.push({ channel })
      return () => {}
    },
    cast: (method: string, ...args: unknown[]) => casts.push({ method, args }),
    request: (method: string, ...args: unknown[]) => {
      requests.push({ method, args })
      return Promise.resolve({ clientId: 3, peers: [] })
    }
  }
}

describe('buildPresenceApi', () => {
  it('hello is a request; cursor/focus/chat/project are casts; onSync/onPeer subscribe', async () => {
    const c = fakeClient()
    const { presence } = buildPresenceApi(c as never)

    await expect(presence.hello({ name: 'Ada', color: PRESENCE_COLORS[0] })).resolves.toEqual({
      clientId: 3,
      peers: []
    })
    expect(c.requests).toEqual([
      { method: IPC.presenceHello, args: [{ name: 'Ada', color: PRESENCE_COLORS[0] }] }
    ])

    presence.cursor({ x: 1, y: 2 })
    presence.cursor(null)
    presence.focus('node-a')
    presence.chat('hey')
    presence.project('web')
    expect(c.casts).toEqual([
      { method: IPC.presenceCursor, args: [{ x: 1, y: 2 }] },
      { method: IPC.presenceCursor, args: [null] },
      { method: IPC.presenceFocus, args: ['node-a'] },
      { method: IPC.presenceChat, args: ['hey'] },
      { method: IPC.presenceProject, args: ['web'] }
    ])

    const un1 = presence.onSync(() => {})
    const un2 = presence.onPeer(() => {})
    expect(c.subs).toEqual([{ channel: IPC.presenceSync }, { channel: IPC.presencePeer }])
    expect(typeof un1).toBe('function')
    expect(typeof un2).toBe('function')
  })
})
