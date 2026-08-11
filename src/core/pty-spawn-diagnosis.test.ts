import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyDevices } from './pty-devices'

/**
 * WHAT THE SPAWN FAILURE SAYS.
 *
 * node-pty reports every failure as a bare `posix_spawnp failed.` with the errno discarded, so the
 * error message is assembled from measurements taken after the fact. This pins the wiring: the
 * pty-DEVICE measurement actually reaches the message, and it replaces the generic
 * restart/rebuild advice rather than being appended to it (2026-08-11 — the machine was at
 * `kern.tty.ptmx_max`, and the message talked about architecture).
 */

/** Every spawn in this file fails: the message is the whole subject. */
vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('posix_spawnp failed.')
  }
}))

/** What the (real) device probe would have measured — set per test. */
const devices = vi.hoisted(() => ({
  current: { ceiling: null, inUse: null } as PtyDevices
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => devices.current
}))

const ALICE = 1

describe('spawn failure diagnosis', () => {
  let fake: FakePlatform

  beforeEach(() => {
    devices.current = { ceiling: null, inUse: null }
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => resetPlatformForTests())

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (): Promise<unknown> =>
    fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24, persistKey: 'node-1' }) as Promise<
      unknown
    >

  it('names the machine pty-device limit — with both numbers — when that is what is full', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow(/out of pty devices \(515 of 511/)
  })

  it('says the pty limit INSTEAD of the rebuild advice, not alongside it', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow(/kern\.tty\.ptmx_max/)
    await expect(create()).rejects.not.toThrow(/npm run rebuild/)
  })

  it('keeps the live-PTY / open-files context either way', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 515 }

    await expect(create()).rejects.toThrow(/live PTYs: 0/)
  })

  it('falls back to the unchanged generic advice on a machine with pty devices to spare', async () => {
    await manager()
    devices.current = { ceiling: 511, inUse: 62 }

    await expect(create()).rejects.toThrow(/npm run rebuild/)
    await expect(create()).rejects.not.toThrow(/pty devices/)
  })
})
