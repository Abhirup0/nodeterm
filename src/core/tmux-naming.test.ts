import { describe, it, expect } from 'vitest'
import {
  localFramedDelivery,
  localTmuxEnterArgs,
  localTmuxPasteArgs,
  pasteBufferName,
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

describe('localTmuxEnterArgs', () => {
  // The bare submit, used only for `sendText('', { enter: true })` now that the ordinary path is
  // one atomic tmux command list. It carries no literal body, so it needs no `--`.
  it('is a plain Enter with no payload', () => {
    expect(localTmuxEnterArgs('sock', 'nt-x')).toEqual([
      '-L',
      'sock',
      'send-keys',
      '-t',
      'nt-x',
      'Enter'
    ])
    expect(localTmuxEnterArgs(TMUX_SOCKET, 'nt-x')).not.toContain('-l')
  })
})

/**
 * The delivery `sendText` actually uses. Structure only — `tmux-paste.realtmux.test.ts` is where
 * the same argv is handed to a real tmux driving a real application and the BYTES are judged.
 */
describe('localTmuxPasteArgs', () => {
  const BUF = 'nt-paste-deadbeef'

  it('is one invocation: stdin buffer, gated cancel, framed paste, Enter — in that order', () => {
    expect(localTmuxPasteArgs('sock', 'nt-x', BUF, true)).toEqual([
      '-L', 'sock',
      'load-buffer', '-b', BUF, '-',
      ';', 'if-shell', '-F', '-t', 'nt-x', '#{pane_in_mode}', 'send-keys -t nt-x -X cancel',
      ';', 'paste-buffer', '-d', '-p', '-r', '-b', BUF, '-t', 'nt-x',
      ';', 'send-keys', '-t', 'nt-x', 'Enter'
    ])
  })

  it('omits the Enter for a dictation insert', () => {
    expect(localTmuxPasteArgs('sock', 'nt-x', BUF, false)).not.toContain('Enter')
  })

  // The version floor this PR removes. `#{bracket_paste_flag}` first shipped in tmux 3.7; every
  // older tmux expanded it to '' and the delivery mangled the write. Nothing here may depend on it.
  it('never reads #{bracket_paste_flag} — `-p` asks the pane instead, and has since tmux 1.7', () => {
    const args = localTmuxPasteArgs('sock', 'nt-x', BUF, true)
    expect(args).not.toContain('#{bracket_paste_flag}')
    expect(args).not.toContain('display-message')
    expect(args).toContain('-p')
  })

  // Everything the payload could have been is absent: it goes down stdin, which is both the
  // MAX_ARG_STRLEN fix and the repo rule that no payload rides a command line.
  it('carries no payload of any kind', () => {
    const args = localTmuxPasteArgs('sock', 'nt-x', BUF, true)
    expect(args).not.toContain('set-buffer')
    expect(args).not.toContain('-l')
    expect(args.filter((a) => a === '-')).toHaveLength(1) // load-buffer's stdin marker
  })

  it('gives every call its own buffer, so two concurrent deliveries cannot overwrite each other', () => {
    const names = new Set(Array.from({ length: 200 }, () => pasteBufferName()))
    expect(names.size).toBe(200)
    for (const n of names) expect(n).toMatch(/^nt-paste-[0-9a-f]{12}$/)
  })

  it('refuses anything spliced unquoted that this app did not generate', () => {
    expect(() => localTmuxPasteArgs('sock', 'nt-x; kill-server', BUF, true)).toThrow(/paste target/)
    expect(() => localTmuxPasteArgs('sock', sessionName(''), BUF, true)).toThrow(/paste target/)
    expect(() => localTmuxPasteArgs('sock', 'nt-x', 'buffer0', true)).toThrow(/buffer name/)
    expect(() => localTmuxPasteArgs('sock', sessionName('term-mabc-3'), pasteBufferName(), true)).not.toThrow()
  })
})

/**
 * The messaging envelope's delivery (`deliverAgentMessage` → `PtyManager.sendFramedPayload`). The
 * payload arrives ALREADY FRAMED by `bracketedInjection` — markers, sanitized body, trailing `\r`
 * all composed in `src/core` — so this plan's one job is to move those bytes verbatim: stdin in,
 * `paste-buffer -r` out, and NO `-p` (tmux re-framing an already-framed payload would turn the
 * inner markers into visible garbage in the target's composer).
 */
describe('localFramedDelivery', () => {
  const PASTE_START = '\x1b[200~'
  const PASTE_END = '\x1b[201~'
  const framed = (inner: string): string => PASTE_START + inner + PASTE_END + '\r'

  it('moves the payload byte-for-byte — the frame markers survive to the pane', () => {
    const payload = framed('line one\nline two')
    const plan = localFramedDelivery('sock', 'nt-x', payload)
    // The mutation this catches: a "helpful" sanitizePasteText here strips the ESC bytes that ARE
    // the frame, and the multi-line body would land unframed — herdr :260, reintroduced by us.
    expect(plan?.body).toBe(payload)
  })

  it('is one invocation: stdin buffer, gated cancel, raw paste — no -p, no separate Enter', () => {
    const plan = localFramedDelivery('sock', 'nt-x', framed('hi'))!
    const buf = plan.args[plan.args.indexOf('-b') + 1]
    expect(buf).toMatch(/^nt-paste-[0-9a-f]{12}$/)
    expect(plan.args).toEqual([
      '-L', 'sock',
      'load-buffer', '-b', buf, '-',
      ';', 'if-shell', '-F', '-t', 'nt-x', '#{pane_in_mode}', 'send-keys -t nt-x -X cancel',
      ';', 'paste-buffer', '-d', '-r', '-b', buf, '-t', 'nt-x'
    ])
    // No `-p`: the frame is already in the bytes. No trailing Enter: the `\r` rides INSIDE the
    // one paste, so text and submit cannot be re-chunked apart (herdr :48).
    expect(plan.args).not.toContain('-p')
    expect(plan.args).not.toContain('Enter')
    expect(plan.cleanup).toEqual(['-L', 'sock', 'delete-buffer', '-b', buf])
  })

  it('refuses a payload that is not a well-formed, pre-sanitized frame', () => {
    // This plan deliberately does NOT sanitize (the frame's own ESC bytes must survive), so it
    // must refuse anything that is not `bracketedInjection` output — otherwise it would be the
    // one path where unsanitized text reaches a pane. Same fail direction as assertPasteTarget.
    expect(() => localFramedDelivery('sock', 'nt-x', 'naked text\r')).toThrow(/framed/)
    expect(() => localFramedDelivery('sock', 'nt-x', PASTE_START + 'no close')).toThrow(/framed/)
    // An ESC inside the frame could close it early — bracketedInjection can never produce this.
    expect(() => localFramedDelivery('sock', 'nt-x', framed(`a${PASTE_END}b`))).toThrow(/framed/)
    expect(() => localFramedDelivery('sock', 'nt-x', framed('a\x1b[31mb'))).toThrow(/framed/)
    // Without the trailing \r is also legal composition (enter: false).
    expect(() => localFramedDelivery('sock', 'nt-x', PASTE_START + 'ok' + PASTE_END)).not.toThrow()
  })

  it('answers null for an empty frame — there is no bare-Enter case for an envelope', () => {
    expect(localFramedDelivery('sock', 'nt-x', '')).toBeNull()
  })

  it('refuses an unsafe target like every other builder', () => {
    expect(() => localFramedDelivery('sock', 'nt-x; kill-server', framed('x'))).toThrow(/paste target/)
  })
})
