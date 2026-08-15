// The shape of "who owns this pane", and the predicate that reads it.
//
// The TYPE lives here, in `src/shared`, because both directions need it: `src/core` PRODUCES it
// (`core/agents/pane-owner.ts` parses it out of tmux + ps, `PtyManager.paneOwner` assembles it) and
// the predicate below CONSUMES it. `src/shared` is the leaf every shell already imports, so this is
// the one placement that does not make `src/shared` depend on `src/core`.

/**
 * Kernel truth about a tmux pane at one instant.
 *
 *  - `panePid`  — `#{pane_pid}`, the process tmux forked for the pane (usually the login shell).
 *  - `tty`      — `#{pane_tty}`, the pane's pty. This is the handle the foreground process GROUP is
 *                 read through, because the kernel tracks that per terminal, not per process.
 *  - `command`  — `#{pane_current_command}`, tmux's own shallow answer. Kept because it is free and
 *                 because it is what the old gate used; it is NOT what the predicate decides on.
 *                 Measured on this host: a pane running `node …/claude --resume x` reports
 *                 `command: 'node'`. A name-based gate cannot see the difference between that and
 *                 any other node process.
 *  - `argv`     — every member of the pane's FOREGROUND process group, full command line, in the
 *                 order `ps` listed them (pid order, so the group leader is first).
 */
export interface PaneOwner {
  panePid: number
  tty: string
  command: string
  argv: readonly string[]
}

/**
 * Three-valued on purpose — `unknown` is NOT a shade of `not-agent`.
 *
 *  - `agent`     — the kernel answered and the expected agent binary owns the foreground group.
 *  - `not-agent` — the kernel answered and the answer was no. Terminal; do not retry.
 *  - `unknown`   — the probe failed (no tmux, dead pane, `ps` unavailable, deadline lapsed). The
 *                  caller may retry. It must never be upgraded to `agent`.
 */
export type AgentPaneVerdict = 'agent' | 'not-agent' | 'unknown'

/**
 * The binary names each built-in agent's CLI actually runs as. Mirrors `AGENT_CONFIG[x].launchCmd`
 * / `.expectedProcess`, kept as its own list so a launch-command change (a wrapper, a flag) cannot
 * silently widen or narrow a SECURITY predicate. A custom agent (`custom:<uuid>`) has no entry —
 * see `isAgentPane`'s `unknown` for what that means.
 */
export const AGENT_BINARIES: Record<string, readonly string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini'],
  opencode: ['opencode'],
  grok: ['grok']
}

/**
 * Interpreters that are followed by the script they run. `node /usr/local/bin/claude` is the shape
 * every npm-installed agent CLI actually has on this host (measured), so argv[0]'s basename alone
 * would answer `node` for every one of them.
 *
 * Resolution applies ONLY when the next token is not an option: `sh -c 'grep -r claude .'` must not
 * resolve to `grep`, and `python3 -i` must not resolve to anything. An interpreter whose next token
 * starts with `-` keeps its own name.
 */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl'])

/** basename, with a login shell's leading `-` stripped (`-zsh` → `zsh`). */
function baseName(token: string): string {
  const noDash = token.replace(/^-/, '')
  return noDash.split('/').pop() ?? ''
}

/**
 * The binary a command line actually runs, as a bare name. Splits on whitespace only — this is a
 * `ps` line, already tokenised by the kernel's argv, and a quoted path with a space in it is not
 * worth a shell-grammar parser here: the failure mode is a name that matches nothing, i.e. a
 * refusal, which is the safe direction.
 */
function effectiveBinary(commandLine: string): string {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  const head = baseName(tokens[0])
  if (!INTERPRETERS.has(head)) return head
  const next = tokens[1]
  if (!next || next.startsWith('-')) return head
  return baseName(next)
}

/**
 * POSITIVE and kernel-truth, replacing `!isShellCommand(pane)`, which was neither.
 *
 * The old gate asked a persisted field what the pane SHOULD be running. `agentId` is durable and
 * outlives the CLI, so a plain terminal whose claude exited weeks ago still read as an agent — and
 * `isShellCommand` is a SEVEN-NAME allowlist (zsh/bash/sh/fish/dash/ksh/tcsh), so `nu`, `pwsh`,
 * `xonsh`, `ssh` and `python` all fell through its negation and were admitted as agents. Text
 * delivered to any of those EXECUTES, because sendText appends Enter.
 *
 * `unknown` is a third answer, not a shade of `not-agent`, because the two need different replies:
 * `unknown` means the probe failed and the caller may retry; `not-agent` means the kernel answered
 * and the answer was no.
 *
 * Matched on the BASENAME of argv[0] (after interpreter resolution), never on a substring of the
 * command line — `vim /etc/claude.conf` and `grep -r claude .` are not claude panes.
 *
 * `binaries` overrides the built-in table for a custom agent whose binary the caller knows. Without
 * it an agent id with no entry answers `unknown`: we cannot name what should be there, so we cannot
 * claim to have seen it.
 *
 * `isShellCommand` is deliberately NOT deleted — its existing callers (the restart exit poll, the
 * reconnect resync) ask a genuinely different question ("has the CLI let go of the pane?") for
 * which a shell allowlist is the right shape.
 */
export function isAgentPane(
  owner: PaneOwner | null | undefined,
  expected: string,
  binaries?: readonly string[]
): AgentPaneVerdict {
  if (!owner) return 'unknown'
  if (!owner.argv || owner.argv.length === 0) return 'unknown'
  const wanted = binaries ?? AGENT_BINARIES[expected]
  if (!wanted || wanted.length === 0) return 'unknown'
  for (const line of owner.argv) {
    if (wanted.includes(effectiveBinary(line))) return 'agent'
  }
  return 'not-agent'
}
