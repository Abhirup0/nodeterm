import { describe, expect, it, vi } from 'vitest'
import type { HostSession } from './session'
import { killHostSession } from './kill-session'

describe('session-host explicit kill truth', () => {
  it('propagates a process kill failure without retiring the live generation', async () => {
    const failure = new Error('synthetic access denied')
    const session = {
      exited: false,
      proc: {
        kill: vi.fn(() => {
          throw failure
        })
      }
    } as unknown as HostSession
    const beginRetirement = vi.fn(async () => {})

    await expect(killHostSession(session, beginRetirement)).rejects.toBe(failure)
    expect(beginRetirement).not.toHaveBeenCalled()
  })

  it('keeps the kill request pending until observed exit retirement resolves', async () => {
    let releaseRetirement!: () => void
    const session = {
      exited: false,
      retiring: false,
      proc: { kill: vi.fn() }
    } as unknown as HostSession
    const beginRetirement = vi.fn((value: HostSession) => {
      value.retiring = true
      return new Promise<void>((resolve) => {
        releaseRetirement = resolve
      })
    })

    let settled = false
    const killing = killHostSession(session, beginRetirement).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(session.proc.kill).toHaveBeenCalledOnce()
    expect(beginRetirement).toHaveBeenCalledWith(session)
    expect(session.retiring).toBe(true)
    expect(settled).toBe(false)

    releaseRetirement()
    await killing
    expect(settled).toBe(true)
  })

  it('awaits the existing retirement barrier without signalling twice', async () => {
    const session = {
      exited: false,
      retiring: true,
      proc: { kill: vi.fn() }
    } as unknown as HostSession
    const beginRetirement = vi.fn(async () => {})

    await expect(killHostSession(session, beginRetirement)).resolves.toBeUndefined()
    expect(session.proc.kill).not.toHaveBeenCalled()
    expect(beginRetirement).toHaveBeenCalledWith(session)
  })
})
