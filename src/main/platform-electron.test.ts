import { describe, it, expect, vi, beforeEach } from 'vitest'

const h: {
  handlers: Record<string, (...a: any[]) => unknown>
  sent: Array<{ id?: number; channel: string; args: any[] }>
} = { handlers: {}, sent: [] }

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/ud',
    getVersion: () => '9.9.9',
    isPackaged: false,
  },
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => unknown) => {
      h.handlers[ch] = fn
    },
    on: (ch: string, fn: (...a: any[]) => void) => {
      h.handlers[ch] = fn
    },
  },
  webContents: {
    fromId: (id: number) =>
      id === 1
        ? { isDestroyed: () => false, send: (ch: string, ...args: any[]) => h.sent.push({ id, channel: ch, args }) }
        : undefined,
  },
  shell: { openExternal: vi.fn(async () => {}) },
}))

vi.mock('./main-window', () => ({
  sendToMain: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }),
}))

import { electronPlatform } from './platform-electron'

beforeEach(() => {
  h.handlers = {}
  h.sent = []
})

describe('electronPlatform', () => {
  it('exposes app paths and version', () => {
    const p = electronPlatform()
    expect(p.userDataDir).toBe('/tmp/ud')
    expect(p.appVersion).toBe('9.9.9')
    expect(p.isPackaged).toBe(false)
  })

  it('strips the ipc event from handle/on and forwards sender id in handleWithSender', async () => {
    const p = electronPlatform()
    p.handle('c1', (a: number) => a + 1)
    expect(await h.handlers['c1']({ sender: { id: 1 } }, 41)).toBe(42)
    p.handleWithSender('c2', (senderId: number, a: string) => `${senderId}:${a}`)
    expect(await h.handlers['c2']({ sender: { id: 7 } }, 'x')).toBe('7:x')
  })

  it('sendTo drops silently when the webContents is gone', () => {
    const p = electronPlatform()
    p.sendTo(1, 'ev', 'a')
    p.sendTo(999, 'ev', 'b') // must not throw
    expect(h.sent).toEqual([{ id: 1, channel: 'ev', args: ['a'] }])
  })
})
