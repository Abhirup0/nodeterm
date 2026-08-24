import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { hookSockPath, SUN_PATH_BUDGET } from './hook-sock-path'

describe('hookSockPath — the SUN_LEN discipline', () => {
  const home = '/home/u'

  it('binds under the data dir with a deliberately short name when it fits', () => {
    expect(hookSockPath('/data/nodeterm', home)).toBe('/data/nodeterm/sock/hook.sock')
  })

  it('falls back to a digest-keyed homedir path when the data dir would blow sun_path', () => {
    const long = '/Users/a-very-long-username/Library/Application Support/' + 'x'.repeat(80)
    const p = hookSockPath(long, home)
    expect(p.startsWith(path.join(home, '.nodeterm', 'sock') + path.sep)).toBe(true)
    expect(p).toMatch(/hook-[0-9a-f]{16}\.sock$/)
    // The point of the fallback: the result itself must FIT.
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(SUN_PATH_BUDGET)
  })

  it('keys the fallback to the data dir, so two instances never fight over one socket', () => {
    const a = hookSockPath('/very/long/'.repeat(12) + 'instance-a', home)
    const b = hookSockPath('/very/long/'.repeat(12) + 'instance-b', home)
    expect(a).not.toBe(b)
  })

  it('the budget sits under the tightest real limit (macOS: 104 bytes including the NUL)', () => {
    expect(SUN_PATH_BUDGET).toBeLessThanOrEqual(103)
  })
})
