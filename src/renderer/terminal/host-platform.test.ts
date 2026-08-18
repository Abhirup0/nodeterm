import { describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { hostPlatformFor } from './host-platform'

const apiWith = (tmuxStatus: () => Promise<unknown>): NodeTerminalApi =>
  ({ pty: { tmuxStatus } } as unknown as NodeTerminalApi)

describe('hostPlatformFor', () => {
  it('coalesces every terminal on one core onto one immutable platform read', async () => {
    const tmuxStatus = vi.fn(async () => ({ platform: 'win32' }))
    const api = apiWith(tmuxStatus)

    await expect(Promise.all([hostPlatformFor(api), hostPlatformFor(api)])).resolves.toEqual([
      'win32',
      'win32'
    ])
    expect(tmuxStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed read unknown', async () => {
    const api = apiWith(vi.fn(async () => Promise.reject(new Error('offline'))))
    await expect(hostPlatformFor(api)).resolves.toBeNull()
  })

  it('does not share a platform fact between different cores', async () => {
    const linux = apiWith(vi.fn(async () => ({ platform: 'linux' })))
    const windows = apiWith(vi.fn(async () => ({ platform: 'win32' })))
    await expect(Promise.all([hostPlatformFor(linux), hostPlatformFor(windows)])).resolves.toEqual([
      'linux',
      'win32'
    ])
  })
})
