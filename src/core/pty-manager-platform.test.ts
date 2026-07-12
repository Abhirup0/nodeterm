import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'

describe('PtyManager platform registration', () => {
  let fake: ReturnType<typeof fakePlatform>
  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => resetPlatformForTests())

  it('registers all pty channels on the platform', async () => {
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    for (const ch of [
      IPC.ptyCreate,
      IPC.ptyWrite,
      IPC.ptyResize,
      IPC.ptyFlow,
      IPC.ptyKill,
      IPC.ptyDestroy,
      IPC.ptySendText,
      IPC.ptyReadScrollback
    ]) {
      // ptyKill is sender-aware (co-attach: unsubscribe ONE client) → senderListeners.
      expect(fake.handlers[ch] ?? fake.listeners[ch] ?? fake.senderListeners[ch], ch).toBeDefined()
    }
  })
})
