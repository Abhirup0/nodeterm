/**
 * Size negotiation for a co-attached PTY: several subscribers watch ONE tmux client, each with
 * its own zoom/DPI/window size, so they compute different cols/rows. The pty runs at the
 * SMALLEST of them — a subscriber that renders fewer columns than the pty emits would wrap and
 * corrupt its screen, while a subscriber with room to spare can simply letterbox the remainder.
 *
 * Deliberately pure (no node-pty, no platform): with exactly ONE subscriber the min of a
 * one-element set is that subscriber's own size, which is what keeps the single-user path
 * bit-for-bit identical to the pre-co-attach behavior.
 */
export interface PtySize {
  cols: number
  rows: number
}

/** Smallest cols × smallest rows across all subscribers; null when there are none. */
export function effectiveSize(sizes: Iterable<PtySize>): PtySize | null {
  let cols = Infinity
  let rows = Infinity
  let any = false
  for (const s of sizes) {
    if (Number.isFinite(s.cols)) cols = Math.min(cols, s.cols)
    if (Number.isFinite(s.rows)) rows = Math.min(rows, s.rows)
    any = true
  }
  if (!any) return null
  // node-pty throws on a 0 dimension, and a not-yet-measured subscriber can report 0. It also
  // wants INTEGERS — xterm's fit addon can report a fractional measurement on a zoomed/HiDPI
  // canvas — so floor first (round down: never claim more columns than the smallest client has)
  // and clamp to >= 1 after, so a sub-1 measurement still yields a 1-col pty rather than 0.
  return {
    cols: Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : 1,
    rows: Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1
  }
}
