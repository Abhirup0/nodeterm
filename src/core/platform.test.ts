import { describe, it, expect, afterEach } from 'vitest'
import { initPlatform, platform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

afterEach(() => resetPlatformForTests())

describe('core platform accessor', () => {
  it('throws before initialization', () => {
    expect(() => platform()).toThrow(/not initialized/)
  })

  it('returns the initialized platform', () => {
    const fake = fakePlatform({ userDataDir: '/tmp/x' })
    initPlatform(fake)
    expect(platform().userDataDir).toBe('/tmp/x')
  })

  it('fake records handlers, sends and openExternal', async () => {
    const fake = fakePlatform()
    fake.handle('a:b', () => 42)
    expect(await fake.handlers['a:b']()).toBe(42)
    fake.sendTo(7, 'ev', 1)
    fake.broadcast('ev2', 'x')
    await fake.openExternal('https://example.com')
    expect(fake.sent).toEqual([
      { to: 7, channel: 'ev', args: [1] },
      { to: 'broadcast', channel: 'ev2', args: ['x'] },
    ])
    expect(fake.opened).toEqual(['https://example.com'])
  })

  it('fake clientIds reflects the attached-client list tests set up', () => {
    const fake = fakePlatform()
    expect(fake.clientIds()).toEqual([])
    fake.clients.push(1, 2)
    expect(fake.clientIds()).toEqual([1, 2])
  })

  it('fake records onWithSender listeners and passes the sender id through', () => {
    const fake = fakePlatform()
    const seen: Array<[number, string]> = []
    fake.onWithSender('a:cast', (senderId: number, text: string) => seen.push([senderId, text]))
    fake.senderListeners['a:cast'](7, 'hi')
    expect(seen).toEqual([[7, 'hi']])
  })
})
