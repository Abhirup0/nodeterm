import { describe, it, expect } from 'vitest'
import {
  localTmuxSendKeysArgs,
  localTmuxEnterArgs,
  sessionName,
  isSessionName,
  TMUX_SOCKET
} from './tmux-naming'

describe('sessionName / isSessionName', () => {
  it('round-trips a plain node id', () => {
    expect(isSessionName(sessionName('abc-123'))).toBe(true)
  })
  it('refuses a target that did not come from sessionName', () => {
    expect(isSessionName('nt-a b')).toBe(false)
    expect(isSessionName('other')).toBe(false)
  })
})

/**
 * SECURITY — the payload must not be able to become an OPTION.
 *
 * `send-keys -l <text>` stops being "type this literally" the moment `<text>` begins with `-`:
 * tmux is still in option-parsing mode, so the payload is read as flags. `--` is what ends option
 * parsing, and the remote path has always had it (`remoteTmuxSendKeysArgs`) while the local one
 * did not — the exact drift `sanitizePasteText`'s own header warns about.
 */
describe('localTmuxSendKeysArgs', () => {
  it('ends option parsing before the payload', () => {
    const args = localTmuxSendKeysArgs('sock', 'nt-x', 'hello')
    expect(args).toEqual(['-L', 'sock', 'send-keys', '-t', 'nt-x', '-l', '--', 'hello'])
  })
  it('puts `--` immediately before the body, whatever the body is', () => {
    // Every payload here exits 0 as a FLAG on tmux 3.4 — i.e. was accepted, typed nothing, and let
    // the caller believe it had been delivered. `-R` additionally resets the pane display.
    for (const body of ['-R', '-K', '-l', '--', '-H', '-F', '-N 3', '\x1b[200~x\x1b[201~\r']) {
      const args = localTmuxSendKeysArgs(TMUX_SOCKET, 'nt-x', body)
      expect(args[args.length - 2]).toBe('--')
      expect(args[args.length - 1]).toBe(body)
    }
  })
  it('the Enter is a separate command and carries no literal body to protect', () => {
    expect(localTmuxEnterArgs('sock', 'nt-x')).toEqual([
      '-L',
      'sock',
      'send-keys',
      '-t',
      'nt-x',
      'Enter'
    ])
  })
})
