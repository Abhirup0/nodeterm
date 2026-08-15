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
