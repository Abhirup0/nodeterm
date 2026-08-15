// Pure tmux naming helpers shared by the PTY manager and the context-link backend.
// No native/electron imports, so this module is safe to import from unit tests.
import { randomBytes } from 'crypto'

export const TMUX_SOCKET = 'node-terminal'

/** Per-node tmux session name. Must stay stable — it is the persistence key. */
export function sessionName(persistKey: string): string {
  return `nt-${persistKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/**
 * Is this a tmux target THIS app generated (i.e. the output of `sessionName` for some node id)?
 *
 * The check exists for the one caller that cannot quote: a tmux control-mode command is a single
 * text line and `encodeSendKeysHex` interpolates its target into it UNQUOTED, so a target carrying
 * a space would split into the wrong arguments and one carrying a newline would run a second
 * command. `sessionName` already sanitizes everything outside `[A-Za-z0-9_-]` away, so this can only
 * fail on a name that did not come from it — an empty node id, or a raw target somebody passed in.
 * Refusing there is cheap; the alternative is a shell-grade escaping problem on a line that reaches
 * a tmux server with every session on it.
 */
export function isSessionName(target: string): boolean {
  return /^nt-[A-Za-z0-9_-]+$/.test(target)
}

/**
 * ── DELETED: `localTmuxSendKeysArgs` ────────────────────────────────────────────────────────────
 *
 * It built `send-keys -t <t> -l -- <body>`, and the `--` was load-bearing: `-l` means "literal
 * characters" but does NOT stop tmux reading further arguments as options, so a payload beginning
 * with `-` was taken as FLAGS. Measured on tmux 3.4, every one of `-R  -K  -l  --  -H  -F  -N 3`
 * exited 0 while typing nothing — the delivery reported success and then sent its Enter, which
 * submitted whatever the human had already composed in that pane (and `-R` had wiped it off the
 * screen first).
 *
 * `sendText` no longer puts the payload in an argument at all: it goes down `load-buffer -`'s
 * stdin. The entire leading-dash class is structurally gone rather than defended against, which
 * is why the builder is gone with it. `local-send-keys.realtmux.test.ts` still runs the `-R`
 * payload through the CURRENT delivery, and still runs the pre-fix argv as a control.
 */

/**
 * A bare Enter. One caller left: `sendText('', { enter: true })`, i.e. "submit whatever is
 * composed". It cannot ride the paste command list, because `load-buffer -` given zero bytes
 * creates no buffer, the `paste-buffer` after it fails, and tmux abandons the rest of the list —
 * the Enter with it (measured). Every non-empty write puts the text and the Enter in ONE tmux
 * invocation, which is also what makes "the Enter can never fire after a failed text send"
 * structural rather than a rule the caller has to remember.
 */
export function localTmuxEnterArgs(socket: string, target: string): string[] {
  return ['-L', socket, 'send-keys', '-t', target, 'Enter']
}

/**
 * ── WHY THE DELIVERY BELOW EXISTS, AND WHAT IT REPLACED ─────────────────────────────────────────
 *
 * A multi-line write must reach a paste-aware TUI INSIDE a bracketed-paste frame. Framed, the app
 * reads the whole thing as one pasted block; unframed, every `\n` is a submit, so a three-line
 * note push becomes three turns (herdr :260) and the last one races the Enter that follows it.
 *
 * The previous design asked tmux WHETHER to frame — `display-message -p '#{bracket_paste_flag}'`
 * — and framed the body itself. Measured: that format FIRST SHIPPED IN TMUX 3.7 (2026-06-26,
 * CHANGES "FROM 3.6b TO 3.7"). On every earlier tmux it is an unknown name that expands to the
 * empty string, so the probe answered false for EVERY pane. And a false answer did not refuse —
 * it fell through to the legacy two-step, which delivered `line1\nline2\nline3` + `\r` raw into
 * the app. Measured on this host (tmux 3.4): exactly those bytes. Ubuntu 24.04 ships 3.4, 22.04
 * → 3.2a, Debian 12/13 → 3.3a/3.5a, Ubuntu 26.04 → 3.6a — plus every SSH target, where the
 * REMOTE host's tmux decides. So the mangle was the norm, not the exception.
 *
 * `paste-buffer -p` removes the question. tmux inserts the bracket codes "if the application has
 * requested bracketed paste mode" — it consults the pane's REAL DECSET 2004 state itself, the
 * state it has tracked since long before it could format it. Introduced 2012-03-03, shipped in
 * TMUX 1.7. There is no version floor left to hit.
 *
 * Measured on tmux 3.4, against a raw-mode reader that records the bytes its stdin actually got:
 *  - app requested 2004 → `ESC[200~ … ESC[201~` then the Enter's `\r`
 *  - app did not        → the text, unframed, byte-identical to the legacy two-step
 *  - a NON-ACTIVE pane  → still framed correctly
 *  - `-r`               → `\n` survives as `\n` (WITHOUT it tmux rewrites every `\n` to `\r`,
 *                          which is the per-line submit this whole thing exists to avoid)
 *  - `-d` + a private buffer name → the user's own numbered buffer stack is untouched
 */

/**
 * A tmux buffer name owned by ONE delivery.
 *
 * Unique per call, not a constant: tmux interleaves command lists from DIFFERENT clients, so two
 * concurrent `sendText`s sharing one buffer name would have the second `load-buffer` overwrite
 * the first's payload before its `paste-buffer` ran — one pane gets the other's text, and the
 * loser's write vanishes. The name is `[a-z0-9-]` only, because it is spliced into a tmux command
 * string and (on the SSH leg) a remote shell line.
 */
export function pasteBufferName(rand: () => string = () => randomBytes(6).toString('hex')): string {
  return `nt-paste-${rand()}`
}

/**
 * The ONE tmux invocation that delivers `sendText`'s payload: load the buffer from STDIN, leave
 * copy mode if the pane is in it, let tmux paste-and-frame it, then Enter. The text itself is not
 * here — it goes over stdin, which is both the ARG_MAX fix and this repo's standing rule.
 *
 * ARG_MAX, measured on this host: `set-buffer -- "$text"` with a 300 KB payload dies with
 * "Argument list too long" (a single argument is capped at MAX_ARG_STRLEN = 128 KB, well under
 * the 2 MB `getconf ARG_MAX`). The same 300 KB through `load-buffer -` lands intact and framed.
 *
 * ── COPY MODE, AND WHY THE CANCEL IS GATED INSIDE TMUX ──────────────────────────────────────────
 *
 * With `#{pane_in_mode}` = 1 (a wheel scroll is enough — nodeterm's tmux has the mouse on),
 * `paste-buffer -p` delivers UNFRAMED: tmux checks the copy-mode screen rather than the app. So
 * the per-line-submit bug comes straight back for a user who happened to be scrolled up. Worse,
 * measured: the trailing `send-keys Enter` is eaten by the copy-mode key table and never reaches
 * the app at all. `send-keys -X cancel` first restores both.
 *
 * The cancel is NOT unconditional. Measured on 3.4: `send-keys -X cancel` against a pane that is
 * NOT in a mode FAILS ("not in a mode", exit 1) and ABORTS THE REST OF THE COMMAND LIST — nothing
 * is pasted, no Enter, and the delivery reports failure. An unconditional cancel would therefore
 * break every ordinary write, which is the opposite of the bug being fixed.
 *
 * `if-shell -F` evaluates a FORMAT (no shell, no fork) and runs its command only when the format
 * is non-zero, so the gate rides inside the same single invocation: no extra round trip, and no
 * probe of ours that a future tmux could change the answer to.
 *
 * The user-visible cost is real but bounded to the case that already misbehaved: a human reading
 * scrollback is scrolled back to the live view. It is not a regression, because TODAY that same
 * pane gets NOTHING — measured: `send-keys -l --` + `send-keys Enter` into a copy-mode pane exits
 * 0 and delivers zero bytes, so `sendText` returns true having written nothing at all.
 *
 * The target is spliced UNQUOTED into the `if-shell` command string (tmux's own lexer parses it),
 * so it must be a name this app generated; `isSessionName` is asserted rather than assumed.
 */
export function localTmuxPasteArgs(
  socket: string,
  target: string,
  buffer: string,
  enter: boolean
): string[] {
  assertPasteTarget(target, buffer)
  const args = [
    '-L',
    socket,
    // stdin, so no payload on a command line and no ARG_MAX ceiling
    'load-buffer',
    '-b',
    buffer,
    '-',
    ';',
    'if-shell',
    '-F',
    '-t',
    target,
    '#{pane_in_mode}',
    `send-keys -t ${target} -X cancel`,
    ';',
    // -d: drop our private buffer afterwards, so the user's paste stack is untouched
    // -p: tmux decides framing from the pane's REAL bracketed-paste state
    // -r: keep `\n` as `\n` instead of tmux's default `\n`→`\r` rewrite
    'paste-buffer',
    '-d',
    '-p',
    '-r',
    '-b',
    buffer,
    '-t',
    target
  ]
  // Same invocation as the paste, so the Enter can never be re-chunked into it — and, because
  // tmux aborts a command list at the first failure, a paste that did not happen can never leave
  // a lone Enter behind to submit whatever the human had composed.
  if (enter) args.push(';', 'send-keys', '-t', target, 'Enter')
  return args
}

/**
 * Shared by the local argv builder and the remote command builder so the two cannot drift on the
 * rule that makes the unquoted splices safe. Throws rather than sanitizing: a caller holding a
 * target this app did not generate is a bug, and `sendText` already turns a throw into `false`.
 */
export function assertPasteTarget(target: string, buffer: string): void {
  if (!isSessionName(target)) throw new Error(`unsafe tmux paste target: ${JSON.stringify(target)}`)
  if (!/^nt-paste-[a-z0-9-]+$/.test(buffer))
    throw new Error(`unsafe tmux buffer name: ${JSON.stringify(buffer)}`)
}
