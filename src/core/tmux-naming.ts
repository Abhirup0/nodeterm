// Pure tmux naming helpers shared by the PTY manager and the context-link backend.
// No native/electron imports, so this module is safe to import from unit tests.

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
 * SECURITY — the literal-text `send-keys` argv for a LOCAL pane, with option parsing ENDED.
 *
 * `-l` means "these are literal characters", but it does NOT stop tmux reading further arguments
 * as options. A payload beginning with `-` is therefore taken as flags, and on tmux 3.4 every one
 * of `-R  -K  -l  --  -H  -F  -N 3` exits 0 while typing nothing. The delivery then reported
 * SUCCESS — and `sendText`'s legacy branch went on to send its Enter, submitting whatever the
 * human had already composed in that pane. An agent's `write --text -R` was a remote "press Enter
 * on whatever is half-typed in that terminal" with no text of its own to show the approver, and
 * `-R` resets the pane DISPLAY as well, so the line being submitted had just been wiped off the
 * screen while readline still held it.
 *
 * The other direction of the same bug is the everyday one: any legitimate text starting with `-`
 * — a dictation insert, a note push, a `/rename` of a title beginning with a dash — was silently
 * not typed at all.
 *
 * `--` is the whole fix, and the remote path (`remoteTmuxSendKeysArgs`) has always had it — its
 * doc comment even says why. Only the local path was missing it. This function exists so the two
 * cannot drift again: every local literal send goes through here, the way every framed body goes
 * through `bracketedInjection`.
 *
 * The socket is a PARAMETER rather than `TMUX_SOCKET` read from module scope so a test can drive
 * a real tmux on a private socket without touching a running app's server.
 */
export function localTmuxSendKeysArgs(socket: string, target: string, body: string): string[] {
  return ['-L', socket, 'send-keys', '-t', target, '-l', '--', body]
}

/**
 * The separate Enter of the legacy (non-bracketed) two-step delivery. It carries no literal body,
 * so it needs no `--` — but it must stay a sibling of `localTmuxSendKeysArgs` because the ORDER is
 * the contract: the text send must succeed before this runs, or the Enter submits somebody else's
 * line. (The remote path spells the same rule as `&&` between the two commands.)
 */
export function localTmuxEnterArgs(socket: string, target: string): string[] {
  return ['-L', socket, 'send-keys', '-t', target, 'Enter']
}
