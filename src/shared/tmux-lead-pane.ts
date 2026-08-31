/**
 * Lead-pane width hooks (issue #119) — the ONE definition both generated tmux configs consume
 * (`tmuxConf` in core/pty-manager.ts and `remoteTmuxConf` in shared/ssh.ts), so the local socket
 * and an SSH host's socket can never drift apart.
 *
 * Why this exists: Claude Code's agent-team tmux backend (traced in the 2.1.227 binary by the
 * issue reporter) hardcodes its geometry — first teammate `split-window -h -l 70%`, every later
 * spawn `select-layout main-vertical` + `resize-pane -t <lead> -x 30%` — and re-applies it on
 * every teammate spawn, so the pane the user actually types into ends up a ~30% column and a
 * manual resize is clobbered seconds later. There is no CC setting for it, and nodeterm owns the
 * tmux server + generated conf, so this is the one place a user preference can live.
 *
 * The mechanism is the reporter's own tested pair of guarded hooks (tmux 3.6a, macOS; re-proven
 * against this repo's tmux in tmux-lead-pane.realtmux.test.ts):
 *  - `after-resize-pane`: if the lead ({top-left}) has been squeezed below the guard threshold,
 *    resize it back to the target width. SELF-TERMINATING by construction: the hook's own
 *    resize-pane fires the same hook again, but by then the lead is at the target (>= guard), the
 *    if-shell no-ops, and the chain stops — the guard threshold sitting BELOW the target is what
 *    makes that true, so `LEAD_PANE_GUARD_GAP` must stay positive. Do not "simplify" the guard
 *    away; it is the part that makes the whole thing safe (no resize loop).
 *  - `after-split-window`: covers the single-teammate case (CC only rebalances at 3+ panes) — a
 *    fresh side-by-side split that squeezed the lead is nudged to the target. Honest side effect,
 *    stated in the Settings row: a manual 50/50 split in a plain terminal node is nudged too.
 *
 * Pane %ids never change across a resize, so CC's teammate tracking (kill/target by %id) is
 * unaffected; if a future CC version changes its layout commands the hooks simply stop firing.
 *
 * OPT-IN, default off: with the setting off both confs are byte-identical to their pre-feature
 * output (pinned in tmux-conf.test.ts / ssh.test.ts) — nodeterm ships no other `set-hook`, and
 * the no-hooks default must stay bit-for-bit unchanged.
 */

/** Bounds for the target width. Below 40% the lead is squeezed anyway (defeats the point) and the
 *  derived guard would approach 0; above 90% teammates become unreadable slivers. */
export const LEAD_PANE_WIDTH_MIN = 40
export const LEAD_PANE_WIDTH_MAX = 90
/** Default target when the user just flips the switch — the reporter's field-tested 72%. */
export const LEAD_PANE_WIDTH_DEFAULT = 72
/** Guard threshold = target − gap. 12 reproduces the reporter's tested 60/72 pair and keeps the
 *  guard strictly below the target for every allowed width (40 → 28), which is what terminates
 *  the resize-hook chain (see the doc comment above). */
export const LEAD_PANE_GUARD_GAP = 12

/**
 * Re-validate the hand-editable setting at the interpolation site (settings.json is user-edited
 * JSON and this number lands inside generated tmux source — same rule as `permissionModeFlag`).
 * Not a number / non-finite / <= 0 ⇒ 0 = off, the bare pre-feature conf. Positive values clamp
 * into [40, 90]: the enable intent is unambiguous, and an out-of-range target would either defeat
 * the guard (too low) or starve the teammates (too high).
 */
export function sanitizeLeadPaneWidth(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const n = Math.round(v)
  if (n <= 0) return 0
  return Math.min(LEAD_PANE_WIDTH_MAX, Math.max(LEAD_PANE_WIDTH_MIN, n))
}

/**
 * The conf lines both `tmuxConf` and `remoteTmuxConf` interpolate. `''` when the setting is off —
 * the interpolation site must add NOTHING of its own around it, so the off path stays
 * byte-identical to the pre-feature conf. When on, the block ends with `\n` so it splices between
 * existing lines cleanly.
 */
export function leadPaneHookLines(widthPct: unknown): string {
  const width = sanitizeLeadPaneWidth(widthPct)
  if (width === 0) return ''
  const guard = width - LEAD_PANE_GUARD_GAP
  return `# Lead-pane width (issue #119, opt-in — see shared/tmux-lead-pane.ts for the full story):
# Claude Code's agent-team backend hardcodes its geometry and re-applies it on every teammate
# spawn, squeezing the lead pane to ~30%. These guarded hooks re-assert the user's target after
# each layout pass. Self-terminating: lead already >= ${guard}% of the window -> no-op, so the
# hook's own resize-pane cannot loop. The guard is load-bearing — do not simplify it away.
# Every comparison is the NUMERIC e| form: measured on tmux 3.4, plain #{<:59,200} answers 0
# (STRING compare — "5" > "2"), which silently killed the reporter's original split hook there.
set-hook -g after-resize-pane "if-shell -F -t '{top-left}' '#{e|<:#{pane_width},#{e|/:#{e|*:#{window_width},${guard}},100}}' { resize-pane -t '{top-left}' -x '${width}%' }"
set-hook -g after-split-window "if-shell -F -t '{top-left}' '#{&&:#{==:#{window_panes},2},#{e|<:#{pane_width},#{window_width}}}' { resize-pane -t '{top-left}' -x '${width}%' }"
`
}
