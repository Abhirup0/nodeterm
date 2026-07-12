import type { CorePlatform } from './platform'

export interface FakePlatform extends CorePlatform {
  handlers: Record<string, (...args: any[]) => unknown>
  listeners: Record<string, (...args: any[]) => void>
  senderListeners: Record<string, (senderId: number, ...args: any[]) => void>
  sent: Array<{ to: number | 'broadcast'; channel: string; args: any[] }>
  opened: string[]
}

/** In-memory CorePlatform for tests. Not a mock library — plain recording object. */
export function fakePlatform(overrides: Partial<CorePlatform> = {}): FakePlatform {
  const f: FakePlatform = {
    userDataDir: '/tmp/nodeterm-test',
    appVersion: '0.0.0-test',
    isPackaged: false,
    handlers: {},
    listeners: {},
    senderListeners: {},
    sent: [],
    opened: [],
    handle(ch, fn) {
      f.handlers[ch] = fn
    },
    on(ch, fn) {
      f.listeners[ch] = fn
    },
    handleWithSender(ch, fn) {
      f.handlers[ch] = fn as (...args: any[]) => unknown
    },
    onWithSender(ch, fn) {
      f.senderListeners[ch] = fn
    },
    sendTo(to, channel, ...args) {
      f.sent.push({ to, channel, args })
    },
    broadcast(channel, ...args) {
      f.sent.push({ to: 'broadcast', channel, args })
    },
    async openExternal(url) {
      f.opened.push(url)
    },
    ...overrides,
  }
  return f
}
