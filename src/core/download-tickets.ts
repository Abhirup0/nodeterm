// One-shot, short-lived tickets that let an ALREADY-AUTHENTICATED caller pull a file down over
// plain HTTP instead of through the RPC bridge.
//
// Why tickets at all: the RPC path (`fs.readBinary`) base64s the whole file into one message and
// is capped at FS_READ_BINARY_MAX_BYTES — fine for an image preview, useless as a download
// transport. A plain HTTP GET streams, shows the browser's own progress, and has no cap. But the
// GET arrives as a top-level navigation, so the safest thing it can carry is a token that means
// nothing on its own: the ticket names the path, so the download route never parses a caller-
// supplied path and needs no jail of its own (the same rule board-log follows — the path always
// derives from the server's own state).
//
// Threat model is otherwise unchanged from `fs-handlers.ts`: minting requires a valid session, and
// whoever has one already has a terminal on this machine. The TTL and the one-shot redeem are
// there so a URL that leaks (history, a shared screen, a proxy log) is inert seconds later.
import { randomBytes } from 'node:crypto'

export interface DownloadTicketEntry {
  path: string
  /** True when the path is a directory — the route streams it as a `.tar.gz`. */
  dir: boolean
  expiresAt: number
}

/** Long enough for a click → navigation round trip on a slow tab, short enough to be worthless
 *  if the URL is ever seen by someone else. */
export const DOWNLOAD_TICKET_TTL_MS = 30_000
/** Backstop so a caller that mints and never redeems can't grow the map without bound. */
const MAX_TICKETS = 256

export class DownloadTickets {
  private tickets = new Map<string, DownloadTicketEntry>()
  private ttlMs: number
  private now: () => number

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DOWNLOAD_TICKET_TTL_MS
    this.now = opts.now ?? Date.now
  }

  /** Mint a token for `path`. The token is the ONLY thing that travels in the URL. */
  issue(path: string, dir: boolean): string {
    this.sweep()
    // Oldest-first eviction under the cap: a flood of un-redeemed tickets expires the stale ones
    // rather than the one the user is about to click.
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next()
      if (oldest.done) break
      this.tickets.delete(oldest.value)
    }
    const token = randomBytes(24).toString('base64url')
    this.tickets.set(token, { path, dir, expiresAt: this.now() + this.ttlMs })
    return token
  }

  /**
   * Redeem a token, or null when it is unknown, already used, or expired. One-shot: the entry is
   * dropped whether or not the transfer that follows succeeds. A retry mints a new ticket — which
   * is cheap — and that is what keeps a captured URL from being replayable.
   */
  redeem(token: string): DownloadTicketEntry | null {
    const entry = this.tickets.get(token)
    if (!entry) return null
    this.tickets.delete(token)
    return entry.expiresAt > this.now() ? entry : null
  }

  private sweep(): void {
    const t = this.now()
    for (const [token, entry] of this.tickets) if (entry.expiresAt <= t) this.tickets.delete(token)
  }
}
