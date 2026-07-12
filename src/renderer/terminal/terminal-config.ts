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
