import type { ClientId } from '@shared/presence'

/**
 * Pure decisions behind the xterm instance in `TerminalNode` — extracted so they can be tested
 * without an xterm/DOM harness (vitest runs in the node environment; there is no jsdom).
 *
 * Everything here belongs to co-attach: one pty, N subscribers. The pty runs at the SMALLEST
 * subscriber's grid, so a terminal no longer owns its own size — it REPORTS what it could render
 * and RENDERS what the pty broadcasts back.
 */

/** A terminal grid. `null` cols/rows on the wire means "subscribed, but not viewing" (parked). */
export interface TermSize {
  cols: number
  rows: number
}

/**
 * The size a terminal REPORTS to the pty. Under co-attach the renderer proposes what it could
 * render (`FitAddon.proposeDimensions()`); the pty then broadcasts the min over all subscribers.
 * `null` means "unmeasurable right now" (a collapsed / zero-size node) — report NOTHING rather
 * than a bogus 0×0, which would clamp every other viewer's terminal to nothing.
 */
export function reportedSize(proposed: Partial<TermSize> | undefined | null): TermSize | null {
  if (!proposed) return null
  const { cols, rows } = proposed
  if (typeof cols !== 'number' || typeof rows !== 'number') return null
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) }
}

/**
 * Are we rendering someone else's (smaller) grid? True when the authoritative size the pty
 * broadcast is smaller than what this node could fit — then the leftover space is letterboxed.
 * A solo user is always the min of a one-element set, so this is ALWAYS false for them and the
 * letterbox styling never engages: their terminal looks exactly as it did before co-attach.
 */
export function isLetterboxed(effective: TermSize, fitted: TermSize | null): boolean {
  if (!fitted) return false
  return effective.cols < fitted.cols || effective.rows < fitted.rows
}

/**
 * Per-node terminal state that must OUTLIVE a mount — because the transport listeners that read it
 * do. `TerminalNode` wires `onSize` / `onClosed` / `onRecycled` ONCE, in the spawn continuation,
 * and an adopted (parked) terminal carries those listeners into the next mount without
 * re-subscribing. Anything they read therefore cannot live in the mounting effect's closure: the
 * live listener would keep reading MOUNT A's variables while mount B updates its own.
 *
 * `fitted` is exactly that: the last size THIS client reported, and the reference the letterbox is
 * measured against (`letterboxFor`). Park, change the font size, come back — mount B fits a
 * different grid, and a closure-captured `fitted` would leave the surviving `onSize` listener
 * comparing the pty's size against the pre-park one, permanently letterboxing a terminal that
 * should fill its node (or un-letterboxing one that shouldn't).
 */
const fittedByNode = new Map<string, TermSize>()

/** Record what this client last REPORTED it can render (called from every applyFit). */
export function setFittedSize(nodeId: string, size: TermSize): void {
  fittedByNode.set(nodeId, size)
}

/** `isLetterboxed` against the CURRENT mount's fit — see `fittedByNode`. */
export function letterboxFor(nodeId: string, effective: TermSize): boolean {
  return isLetterboxed(effective, fittedByNode.get(nodeId) ?? null)
}

/**
 * Node ids whose next spawn is a recycle RESTART: the co-viewer's session was replaced under it
 * (someone moved the node into a worktree), and the new xterm prints a one-line reason — the
 * replacement is a fresh shell in a different folder, so the screen legitimately changes and a
 * silent reset would just look like a glitch.
 *
 * `takeRecycled` consumes the flag, and the spawn path consumes it BEFORE `create()` resolves: a
 * node that unmounts while its create is in flight abandons that spawn, and a flag left behind
 * would print "session restarted by another user" on some unrelated mount hours later.
 */
const recycledIds = new Set<string>()

export function markRecycled(nodeId: string): void {
  recycledIds.add(nodeId)
}

/** Consume the recycle flag: true exactly once per `markRecycled`. */
export function takeRecycled(nodeId: string): boolean {
  return recycledIds.delete(nodeId)
}

/** Drop every cross-mount trace of a node — called when it is permanently deleted. */
export function forgetNodeTermState(nodeId: string): void {
  fittedByNode.delete(nodeId)
  recycledIds.delete(nodeId)
}

/**
 * What a `pty:recycled` notice means for this terminal.
 *
 * `ready` says a REPLACEMENT session is already registered for the node, so restarting is safe:
 * our re-create co-attaches to it and we follow the node into its new cwd.
 *
 * Without one — the recycler's app died between the `tmux kill-session` and its own `create()`, so
 * the notice fired on the escape-hatch timeout — a restart would be actively harmful: our create
 * options still carry the node's OLD cwd (a cwd change is not broadcast to other clients), so we
 * would spawn `nt-<id>` in the stale directory, and the mover's app, on its return, would
 * `new-session -A` straight into it. Everyone's node would then claim the worktree path while the
 * shell sits in the old folder — the exact silent failure the withheld notice exists to prevent.
 * So we DON'T spawn: the terminal ends, and the user reopens it deliberately if they want a shell.
 */
export function recycleAction(info: { ready: boolean } | undefined): 'restart' | 'ended' {
  return info?.ready ? 'restart' : 'ended'
}

/**
 * Should a `pty:resync` payload be painted? The server promises never to send an empty capture,
 * but the renderer guards anyway: a resync RESETS the emulator, and a screen reset on an empty
 * payload is unrecoverable (the user loses the screen for nothing), while a skipped repaint is
 * not (the next byte of output redraws through tmux anyway).
 */
export function shouldApplyResync(screen: string | null | undefined): boolean {
  return typeof screen === 'string' && screen.length > 0
}

/**
 * Make text captured from tmux (`capture-pane`, LF-separated lines) safe to `term.write()`.
 * xterm runs with `convertEol: false` — a bare LF moves down but keeps the column, so raw capture
 * output would render as a staircase. Lone LFs become CRLF; existing CRLFs are left alone.
 */
export function toXtermText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/**
 * Who closed this node, for the "closed by …" overlay. `by` is null when the destroy was not
 * attributed to a client (a local desktop destroy), and an id we have never seen is a peer who
 * already left — both degrade to a neutral label rather than blocking the overlay on presence.
 */
export function closedByLabel(
  by: ClientId | null,
  peers: Record<ClientId, { name: string }>
): string {
  if (by === null) return 'another user'
  return peers[by]?.name || 'another user'
}
