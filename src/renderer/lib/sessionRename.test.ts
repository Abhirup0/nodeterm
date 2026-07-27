import { describe, it, expect, vi } from 'vitest'
import { RENAME_PUSH_ATTEMPTS, pushSessionRename } from './sessionRename'

const io = (panes: (string | null)[] | (() => Promise<string | null>)) => {
  const sent: string[] = []
  let i = 0
  return {
    sent,
    paneCommand: typeof panes === 'function' ? panes : async () => panes[Math.min(i++, panes.length - 1)],
    sendText: async (_k: string, t: string) => {
      sent.push(t)
      return true
    },
    sleep: async () => {}
  }
}

describe('pushSessionRename', () => {
  it('writes as soon as a non-shell owns the pane', async () => {
    const x = io(['claude'])
    await expect(pushSessionRename(x, 'n1', 'My session')).resolves.toBe(true)
    expect(x.sent).toEqual(['/rename My session'])
  })

  it('NEVER writes while a shell owns the pane — that is the launch command being typed', async () => {
    // The regression this exists for: `claude '<long prompt>'` mid-delivery, cut in half by an
    // interleaved rename, leaving the shell at `quote>` and the agent never started.
    const x = io(['zsh'])
    await expect(pushSessionRename(x, 'n1', 'My session')).resolves.toBe(false)
    expect(x.sent).toEqual([])
  })

  it('recognizes a login shell and a full path as shells', async () => {
    for (const pane of ['-zsh', '/bin/bash', 'fish']) {
      const x = io([pane])
      await pushSessionRename(x, 'n1', 'x')
      expect(x.sent, pane).toEqual([])
    }
  })

  it('waits for the CLI to boot, then writes once', async () => {
    const x = io(['zsh', 'zsh', 'node'])
    await expect(pushSessionRename(x, 'n1', 'Later')).resolves.toBe(true)
    expect(x.sent).toEqual(['/rename Later'])
  })

  it('treats a failed probe as "not demonstrated" and stays silent', async () => {
    const x = io(async () => {
      throw new Error('tmux gone')
    })
    await expect(pushSessionRename(x, 'n1', 'x')).resolves.toBe(false)
    expect(x.sent).toEqual([])
  })

  it('treats an unknown (null) pane as "not demonstrated" and stays silent', async () => {
    const x = io([null])
    await expect(pushSessionRename(x, 'n1', 'x')).resolves.toBe(false)
    expect(x.sent).toEqual([])
  })

  it('gives up after a bounded number of attempts rather than probing forever', async () => {
    const probe = vi.fn(async () => 'zsh')
    await pushSessionRename({ paneCommand: probe, sendText: async () => true, sleep: async () => {} }, 'n1', 'x')
    expect(probe).toHaveBeenCalledTimes(RENAME_PUSH_ATTEMPTS)
  })
})
