// Shared UI-sink registry + per-(client, session) WS backpressure (docs/team-presence.md Stage 2).
// EXTRACTED from ServerPlatform so BOTH shells use it: the Server Edition (every browser is a sink)
// and the desktop (relay PEER sinks alongside its webContents clients — docs/remote-sessions.md 4b).
// Pure: no electron, no ws, no disk. Reaches PtyManager only via injected callbacks (setFlowController
// / setResyncProvider) and the sink via the UiSink interface. (see no-electron.test.ts)
import { IPC } from '../shared/ipc'
import { encodePtyData } from '../shared/rpc'
import type { FlowOwner } from './pty-manager'

export interface UiSink {
  sendText(json: string): void
  sendBinary(buf: Uint8Array): void
  /** Bytes queued in the socket send buffer (WebSocket.bufferedAmount). Optional so
   *  tests/sinks that don't report it opt out of flow control (treated as 0). */
  bufferedAmount?(): number
}

const PTY_DATA_PREFIX = 'pty:data:'
/** Session-death channels — the point where a (client, session)'s backpressure state is pruned. */
const PTY_EXIT_PREFIX = 'pty:exit:'
const PTY_CLOSED_PREFIX = 'pty:closed:'
/** A recycled session id is dead too (the node respawns under a NEW session id), so its
 *  backpressure bookkeeping must be pruned exactly like an exited/closed one. */
const PTY_RECYCLED_PREFIX = 'pty:recycled:'
/** Watermarks match the renderer terminal's own flow control. */
const WS_HIGH_WATER = 1_000_000
const WS_LOW_WATER = 256_000
/**
 * Hard ceiling per (client, session). Because backpressure is per-client (a slow client must not
 * pause the pty for everyone), a client that never drains would otherwise grow its send buffer
 * without bound until the server OOMs. Past this we DROP that session's output for that client and
 * redraw it from tmux once it recovers: for a terminal the CURRENT SCREEN is what matters, not the
 * 8 MB of scrollback a bad link missed — replaying that backlog would be slower to deliver, stale
 * on arrival, and keep the buffer full. tmux is the authoritative source of the current screen.
 * Do not "fix" this back into a replay.
 */
const WS_DROP_WATER = 8_000_000
/**
 * How often the desynced set is swept for clients whose socket has drained. A flood that ENDS is
 * the normal case (`npm run build` finishes, the socket drains, no further pty output ever
 * arrives) — driving the redraw off the NEXT chunk of that session would leave such a client on a
 * screen truncated mid-flood forever. The sweep is the drain trigger, and it only runs while
 * something is actually desynced (armed on desync, cleared when the set empties), so the healthy
 * path — the only path a solo user is ever on — pays nothing.
 */
const RESYNC_SWEEP_MS = 250
/** A capture that comes back empty is retried on this schedule (250 ms, 500, 1 s … capped), so a
 *  session that can never be captured cannot turn the sweep into a subprocess treadmill. */
const RESYNC_BACKOFF_MAX_MS = 10_000

/** One (client, session) whose backlog we discarded, and when its redraw may next be attempted. */
type Desync = { attempts: number; nextAttemptAt: number }

/**
 * The reusable UI-sink registry with per-(client, session) WS backpressure. One instance per shell
 * (the Server Edition holds one; the desktop relay holds one for its peer sinks). A sink registers
 * under a caller-chosen numeric id (webContents id, or a minted peer id); the registry never mints.
 *
 * WS backpressure: which (ui, session) streams have been paused, + the controller that pauses/
 * resumes the pty.
 *
 * Both sides are per-CLIENT, and they have to be. Co-attach means one pty fans out to N
 * subscribers, so a pause has to say WHO is behind: PtyManager keeps a per-client ledger
 * (Session.pausedBy), pauses the shared pty while ANY viewer owes a resume, and resumes it only
 * when the last owed resume lands — or when the client that owed it disconnects (dropClient).
 * A `paused` flag keyed by sessionId alone cannot express "behind for browser A, flowing for
 * browser B": B's low-water send would hand back the resume A owes, and with the pty paused no
 * further data would arrive for A to re-assert it — the terminal would hang for both of them.
 *
 * A viewer that STAYS behind does not set the pace for everyone: above WS_DROP_WATER we stop
 * sending to it and redraw it from tmux when it recovers (see `dropOrDesync`), so the pause it
 * owes is bounded in time and the producer is never throttled indefinitely by one bad link.
 */
export class UiSinkRegistry {
  private sinks = new Map<number, UiSink>()
  private paused = new Set<string>()
  private flowController?: (
    uiId: number,
    sessionId: string,
    resume: boolean,
    owner: FlowOwner
  ) => void
  /** Every pause this class books is owed by the SOCKET, never by the browser's xterm — a separate
   *  owner in PtyManager's ledger, because the two queues drain at different times and must not
   *  cancel each other (see `Session.pausedBy` / `FlowOwner`). Passed on every call so the tag is
   *  type-enforced at this seam and cannot be dropped by the wiring in index.ts. */
  private static readonly OWNER: FlowOwner = 'socket'

  /**
   * The (client, session) pairs whose backlog we discarded; each gets a tmux redraw once its
   * socket drains back under WS_LOW_WATER.
   *
   * The BOUND is socket-wide, not per session: `UiSink.bufferedAmount` is `ws.bufferedAmount` —
   * one number for the whole connection, because that is where the bytes actually sit (there is no
   * per-session send queue to measure, and the socket is what would OOM us). So a client that
   * floods the socket past WS_DROP_WATER on ONE session desyncs on EVERY session it is watching,
   * as soon as each gets its next chunk. That is deliberate: at 8 MB queued, that connection is
   * hopeless for all of its terminals, and dropping only the loudest session would leave the
   * others queueing behind the same jammed socket.
   *
   * What IS per (client, session) is the desync STATE and the recovery: each session is captured
   * and repainted on its own, and other VIEWERS of those sessions are untouched (they have their
   * own sockets). Keyed like `paused`.
   */
  private desynced = new Map<string, Desync>()
  /** Redraws currently in flight (a capture is async) — one per (client, session), never N. */
  private resyncing = new Set<string>()
  /** Armed only while `desynced` is non-empty (see RESYNC_SWEEP_MS). */
  private sweepTimer?: ReturnType<typeof setInterval>
  private resyncProvider?: (sessionId: string) => Promise<string>

  register(id: number, sink: UiSink): void {
    this.sinks.set(id, sink)
  }

  has(id: number): boolean {
    return this.sinks.has(id)
  }

  /** Every registered sink, in registration order (Map preserves insertion order). */
  ids(): number[] {
    return [...this.sinks.keys()]
  }

  setFlowController(
    fn: (uiId: number, sessionId: string, resume: boolean, owner: FlowOwner) => void
  ): void {
    this.flowController = fn
  }

  /** How a desynced client is brought back: the session's CURRENT screen, captured from tmux
   *  (PtyManager.captureForResync). Unset (tests / no tmux) means nothing can ever repaint this
   *  client, so a desync is simply cleared and streaming resumes un-repainted — it must never be
   *  left desynced forever, which is what a silent bail-out would do. */
  setResyncProvider(fn: (sessionId: string) => Promise<string>): void {
    this.resyncProvider = fn
  }

  /** Key of one client's view of one session — the unit backpressure is tracked in. */
  private static flowKey(uiId: number, sessionId: string): string {
    return `${uiId} ${sessionId}`
  }

  /** Drop the departing (or gone) client's sink and prune only ITS backpressure entries. Nothing
   *  leaks: uiIds are monotonic, so a reconnect is a new key, and the pty-side pause this
   *  connection owed is returned by PtyManager.dropClient (wired to the same close hook). */
  unregister(id: number): void {
    this.sinks.delete(id)
    const prefix = `${id} `
    for (const key of this.paused) if (key.startsWith(prefix)) this.paused.delete(key)
    // Same for the drop-and-redraw state: a departing client leaves none behind (and an in-flight
    // capture for it lands on a missing sink, so it is discarded — see `resync`).
    for (const key of this.desynced.keys()) if (key.startsWith(prefix)) this.desynced.delete(key)
    this.stopSweepIfIdle() // the last desynced client left → no timer survives it
  }

  sendTo(uiId: number, channel: string, ...args: any[]): void {
    const sink = this.sinks.get(uiId)
    if (!sink) return
    if (channel.startsWith(PTY_DATA_PREFIX)) {
      const sessionId = channel.slice(PTY_DATA_PREFIX.length)
      // Bounded memory: read the socket backlog BEFORE queueing more, so the ceiling can refuse.
      if (this.dropOrDesync(uiId, sessionId, sink.bufferedAmount?.() ?? 0)) return
      sink.sendBinary(encodePtyData(sessionId, String(args[0] ?? '')))
      if (this.flowController) {
        const buffered = sink.bufferedAmount?.() ?? 0
        const key = UiSinkRegistry.flowKey(uiId, sessionId)
        const isPaused = this.paused.has(key)
        if (buffered > WS_HIGH_WATER) {
          // Re-assert the pause on EVERY high send (not just the rising edge), so this set can
          // never disagree with the pty-side ledger about a pause we still owe. It is booked under
          // the 'socket' owner there (see server/index.ts), i.e. a DIFFERENT ticket from the one
          // this connection's browser casts over pty:flow for its own xterm backlog — the two
          // queues drain at different times and must not cancel each other. pause() is idempotent,
          // and this branch only runs when data actually arrived (the pty was running), so it
          // self-limits — no spamming.
          this.paused.add(key)
          // A flood that ENDS is the normal case, and the resume check below only runs when the
          // NEXT chunk for this session is sent. If this is the last chunk, nothing else would ever
          // re-evaluate the pause: the pty would stay paused, the producing process blocked on a
          // full pipe — and with co-attach that freezes the terminal for EVERY viewer. So the same
          // drain sweep the desync path uses watches the socket for us (see sweepDesynced).
          this.armSweep()
          this.flowController(uiId, sessionId, false, UiSinkRegistry.OWNER)
        } else if (isPaused && buffered <= WS_LOW_WATER) {
          this.paused.delete(key)
          this.flowController(uiId, sessionId, true, UiSinkRegistry.OWNER)
        }
      }
    } else {
      // A session that DIED takes its backpressure state with it: nothing will ever be captured or
      // resumed for it again, and a stale desync key would keep the sweep (and its tmux captures)
      // alive for a session that no longer exists. Both channels are per-subscriber, so this prunes
      // exactly the (this client, that session) entries. Costs the healthy path nothing — pty:data
      // never reaches this branch.
      const deadPrefix = [PTY_EXIT_PREFIX, PTY_CLOSED_PREFIX, PTY_RECYCLED_PREFIX].find((p) =>
        channel.startsWith(p)
      )
      if (deadPrefix)
        this.forgetFlowState(UiSinkRegistry.flowKey(uiId, channel.slice(deadPrefix.length)))
      sink.sendText(JSON.stringify({ t: 'ev', channel, args }))
    }
  }

  /** Drop every trace of one (client, session) from the backpressure bookkeeping. The pty-side
   *  pause is not handed back here: these are dead-session / departing-client paths, where
   *  PtyManager's own ledger (kill / dropClient) releases it. */
  private forgetFlowState(key: string): void {
    this.paused.delete(key)
    this.desynced.delete(key)
    this.stopSweepIfIdle()
  }

  /**
   * The bounded-memory gate for one (client, session). Returns true when this chunk must be
   * DISCARDED — either because the client is already desynced (its backlog was dropped and the
   * redraw hasn't landed yet), or because it just crossed WS_DROP_WATER.
   */
  private dropOrDesync(uiId: number, sessionId: string, buffered: number): boolean {
    const key = UiSinkRegistry.flowKey(uiId, sessionId)
    if (this.desynced.has(key)) {
      // Output is still flowing, so take the chance to recover early — the sweep would get there
      // within RESYNC_SWEEP_MS anyway, but a chunk we can see right now is free.
      this.maybeResync(uiId, sessionId, buffered)
      return true
    }
    if (buffered <= WS_DROP_WATER) return false
    // nextAttemptAt 0: the very first drain (from the sweep or the next chunk) redraws immediately.
    this.desynced.set(key, { attempts: 0, nextAttemptAt: 0 })
    this.armSweep()
    // We stopped streaming to this client, so it must not hold the shared pty hostage: a pause it
    // owes could never be returned (it receives nothing, so it can never drain and re-report), and
    // PtyManager keeps the pty paused while ANY client owes a resume — the other viewers' terminal
    // would freeze forever. Hand the pause back here; the clients still being served decide alone.
    if (this.paused.delete(key)) this.flowController?.(uiId, sessionId, true, UiSinkRegistry.OWNER)
    return true
  }

  /** Redraw a desynced client IF it has drained and its (backoff-gated) turn has come. */
  private maybeResync(uiId: number, sessionId: string, buffered: number): void {
    const key = UiSinkRegistry.flowKey(uiId, sessionId)
    const state = this.desynced.get(key)
    if (!state || this.resyncing.has(key)) return
    // Never redraw into a socket that is still backed up: the repaint would queue behind the
    // backlog and be stale by the time it arrived. And never faster than the backoff allows.
    if (buffered > WS_LOW_WATER || Date.now() < state.nextAttemptAt) return
    // A provider that throws would otherwise be an unhandled rejection → process exit under Node's
    // default. `resync` already contains its own failures; this is the last line of defence.
    void this.resync(uiId, sessionId).catch((err) => {
      console.warn(
        '[nodeterm-server] resync failed',
        err instanceof Error ? err.message : String(err)
      )
    })
  }

  /**
   * Redraw one desynced client from tmux, then let it stream again. One capture, never a replay.
   *
   * CONTRACT WITH THE RENDERER: a `pty:resync:<sid>` event is only ever sent with a NON-EMPTY
   * payload, so the renderer may reset the terminal and repaint from it unconditionally. Captures
   * fail empty (`captureForResync` returns '' on any tmux/ssh error — a ControlMaster blip, tmux
   * not yet resolved, a session mid-respawn), and sending that would blank a perfectly live
   * terminal and leave only the separator. So an empty capture sends NOTHING: the client stays
   * desynced (output still dropped, screen intact, if stale) and the sweep retries with backoff.
   */
  private async resync(uiId: number, sessionId: string): Promise<void> {
    const key = UiSinkRegistry.flowKey(uiId, sessionId)
    if (this.resyncing.has(key)) return
    this.resyncing.add(key)
    try {
      if (!this.desynced.has(key)) return
      if (!this.resyncProvider) {
        // No capture path at all (tests / no tmux): retrying is pointless and staying desynced
        // would strand the client forever. Resume streaming un-repainted.
        this.desynced.delete(key)
        return
      }
      let screen = ''
      try {
        screen = await this.resyncProvider(sessionId)
      } catch {
        screen = '' // treated exactly like an empty capture: retry, never clear the screen
      }
      if (!this.sinks.has(uiId)) return // client left while the capture was in flight
      const state = this.desynced.get(key)
      if (!state) return // pruned (session died) while the capture was in flight
      if (!screen) {
        state.attempts++
        state.nextAttemptAt =
          Date.now() + Math.min(RESYNC_SWEEP_MS * 2 ** (state.attempts - 1), RESYNC_BACKOFF_MAX_MS)
        return
      }
      this.desynced.delete(key)
      // Not a pty:data frame, so it is not subject to the gate above (and the flag is cleared
      // anyway): a plain event the terminal turns into a clear + redraw.
      this.sendTo(uiId, IPC.ptyResync(sessionId), screen)
    } finally {
      this.resyncing.delete(key)
      this.stopSweepIfIdle()
    }
  }

  /** The drain trigger, for BOTH backpressure states. A flood that ends leaves no further pty output
   *  to hang a redraw — or a resume — off, so a low-frequency sweep watches the socket instead. It
   *  exists ONLY while something is paused or desynced, so the healthy path (every solo user, and
   *  every client that keeps up) never spins a timer. */
  private armSweep(): void {
    if (this.sweepTimer || (this.desynced.size === 0 && this.paused.size === 0)) return
    this.sweepTimer = setInterval(() => this.sweep(), RESYNC_SWEEP_MS)
    // Must never hold the process (or a vitest run) open.
    this.sweepTimer.unref?.()
  }

  private stopSweepIfIdle(): void {
    if (this.sweepTimer && this.desynced.size === 0 && this.paused.size === 0) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  private sweep(): void {
    this.sweepPaused()
    this.sweepDesynced()
    this.stopSweepIfIdle()
  }

  /**
   * Hand back a pause whose socket has drained, when no further output will do it for us.
   *
   * This is the ONLY thing that unsticks the pause a last-chunk-of-a-flood send left behind: the
   * pty is paused, so no data arrives, so the `pty:data` branch never runs again — and the browser's
   * own flow control cannot rescue it either (it is edge-latched, and on a slow link its xterm
   * backlog never crossed its own high-water mark, so it has no pause to return). With ONE pty and
   * N subscribers, that stuck pause is not one dead UI: it is a dead terminal for everybody.
   *
   * Released at the LOW-water mark, exactly like the in-band check, so a socket that is merely
   * "less full" does not flap the pty.
   */
  private sweepPaused(): void {
    if (!this.flowController) return
    for (const key of [...this.paused]) {
      const sep = key.indexOf(' ')
      const uiId = Number(key.slice(0, sep))
      const sink = this.sinks.get(uiId)
      // Client gone (belt and braces: detach prunes, and PtyManager.dropClient returns the pause
      // it owed on the pty side).
      if (!sink) {
        this.paused.delete(key)
        continue
      }
      if ((sink.bufferedAmount?.() ?? 0) > WS_LOW_WATER) continue
      this.paused.delete(key)
      this.flowController(uiId, key.slice(sep + 1), true, UiSinkRegistry.OWNER)
    }
  }

  private sweepDesynced(): void {
    for (const key of [...this.desynced.keys()]) {
      const sep = key.indexOf(' ')
      const uiId = Number(key.slice(0, sep))
      const sink = this.sinks.get(uiId)
      if (!sink) {
        this.desynced.delete(key) // client gone (belt and braces: detach already prunes)
        continue
      }
      // `maybeResync` is a no-op above the low-water mark and while a capture is in flight, so a
      // client that never drains costs one bufferedAmount read per tick — it cannot spin.
      this.maybeResync(uiId, key.slice(sep + 1), sink.bufferedAmount?.() ?? 0)
    }
  }
}
