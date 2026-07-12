import type { CorePlatform } from '../core/platform'
import {
  E_NO_HANDLER,
  encodePtyData,
  type RpcErr,
  type RpcOk,
  type RpcRequest
} from '../shared/rpc'

export interface UiSink {
  sendText(json: string): void
  sendBinary(buf: Uint8Array): void
  /** Bytes queued in the socket send buffer (WebSocket.bufferedAmount). Optional so
   *  tests/sinks that don't report it opt out of flow control (treated as 0). */
  bufferedAmount?(): number
}

const PTY_DATA_PREFIX = 'pty:data:'
/** Watermarks match the renderer terminal's own flow control. */
const WS_HIGH_WATER = 1_000_000
const WS_LOW_WATER = 256_000

type Handler = { fn: (...args: any[]) => unknown; withSender: boolean }
type Listener = { fn: (...args: any[]) => void; withSender: boolean }

/** The Linux-server CorePlatform: RPC registries + a WS-connection (UiSink) registry.
 *  One instance per server process; each authenticated WebSocket attaches as one UI. */
export class ServerPlatform implements CorePlatform {
  readonly userDataDir: string
  readonly appVersion: string
  readonly isPackaged = true

  private handlers = new Map<string, Handler>()
  // One registry for both on() and onWithSender(), so cast fires listeners in REGISTRATION
  // order across the two — same as Electron's ipcMain.on. A Set preserves insertion order.
  private listeners = new Map<string, Set<Listener>>()
  private sinks = new Map<number, UiSink>()
  private nextUiId = 1

  // WS backpressure: which (ui, session) streams this server has paused, + the controller that
  // pauses/resumes the pty.
  //
  // Both sides are per-CLIENT, and they have to be. Co-attach means one pty fans out to N
  // subscribers, so a pause has to say WHO is behind: PtyManager keeps a per-client ledger
  // (Session.pausedBy), pauses the shared pty while ANY viewer owes a resume, and resumes it only
  // when the last owed resume lands — or when the client that owed it disconnects (dropClient).
  // A `paused` flag keyed by sessionId alone cannot express "behind for browser A, flowing for
  // browser B": B's low-water send would hand back the resume A owes, and with the pty paused no
  // further data would arrive for A to re-assert it — the terminal would hang for both of them.
  //
  // Still Task 5's: a viewer that STAYS behind currently sets the pace for everyone (the slowest
  // socket throttles the shared pty). The fix is a per-client drop-and-redraw above a second,
  // higher watermark (WS_DROP_WATER) rather than pausing the producer indefinitely.
  private paused = new Set<string>()
  private flowController?: (uiId: number, sessionId: string, resume: boolean) => void

  setFlowController(fn: (uiId: number, sessionId: string, resume: boolean) => void): void {
    this.flowController = fn
  }

  /** Key of one client's view of one session — the unit backpressure is tracked in. */
  private static flowKey(uiId: number, sessionId: string): string {
    return `${uiId} ${sessionId}`
  }

  constructor(opts: { userDataDir: string; appVersion: string }) {
    this.userDataDir = opts.userDataDir
    this.appVersion = opts.appVersion
  }

  handle(channel: string, fn: (...args: any[]) => unknown): void {
    this.handlers.set(channel, { fn, withSender: false })
  }

  handleWithSender(channel: string, fn: (senderId: number, ...args: any[]) => unknown): void {
    this.handlers.set(channel, { fn, withSender: true })
  }

  on(channel: string, fn: (...args: any[]) => void): void {
    this.addListener(channel, { fn, withSender: false })
  }

  onWithSender(channel: string, fn: (senderId: number, ...args: any[]) => void): void {
    this.addListener(channel, { fn, withSender: true })
  }

  private addListener(channel: string, listener: Listener): void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(listener)
  }

  sendTo(uiId: number, channel: string, ...args: any[]): void {
    const sink = this.sinks.get(uiId)
    if (!sink) return
    if (channel.startsWith(PTY_DATA_PREFIX)) {
      const sessionId = channel.slice(PTY_DATA_PREFIX.length)
      sink.sendBinary(encodePtyData(sessionId, String(args[0] ?? '')))
      if (this.flowController) {
        const buffered = sink.bufferedAmount?.() ?? 0
        const key = ServerPlatform.flowKey(uiId, sessionId)
        const isPaused = this.paused.has(key)
        if (buffered > WS_HIGH_WATER) {
          // Re-assert the pause on EVERY high send (not just the rising edge). This connection's
          // browser runs the SAME flow control on its xterm backlog and casts pty:flow under the
          // same uiId, so it may have handed back the pause underneath us; an edge-latched
          // `!isPaused` guard would then never re-pause until the buffer drained to LOW.
          // proc.pause() is idempotent, and this branch only runs when data actually arrived (the
          // pty was running), so it self-limits — no spamming.
          this.paused.add(key)
          this.flowController(uiId, sessionId, false)
        } else if (isPaused && buffered <= WS_LOW_WATER) {
          this.paused.delete(key)
          this.flowController(uiId, sessionId, true)
        }
      }
    } else {
      sink.sendText(JSON.stringify({ t: 'ev', channel, args }))
    }
  }

  broadcast(channel: string, ...args: any[]): void {
    for (const uiId of this.sinks.keys()) this.sendTo(uiId, channel, ...args)
  }

  openExternal(_url: string): Promise<void> {
    return Promise.reject(new Error('openExternal is not available on a headless server'))
  }

  attach(sink: UiSink): number {
    const id = this.nextUiId++
    this.sinks.set(id, sink)
    return id
  }

  detach(uiId: number): void {
    this.sinks.delete(uiId)
    // Drop only the DEPARTING connection's backpressure entries. (This used to clear the map for
    // every connection — harmless when the Server Edition was single-UI, wrong the moment two
    // browsers share a session, since it dropped the other one's flags.) Nothing leaks: uiIds are
    // monotonic, so a reconnect is a new key, and the pty-side pause this connection owed is
    // returned by PtyManager.dropClient (wired to the same close hook in server/index.ts).
    const prefix = `${uiId} `
    for (const key of this.paused) if (key.startsWith(prefix)) this.paused.delete(key)
  }

  async dispatch(uiId: number, req: RpcRequest): Promise<RpcOk | RpcErr> {
    const h = this.handlers.get(req.method)
    if (!h) {
      return {
        t: 'res', id: req.id, ok: false,
        error: { code: E_NO_HANDLER, message: `no handler for ${req.method}` }
      }
    }
    try {
      const result = h.withSender ? await h.fn(uiId, ...req.args) : await h.fn(...req.args)
      return { t: 'res', id: req.id, ok: true, result: result ?? null }
    } catch (err) {
      return {
        t: 'res', id: req.id, ok: false,
        error: { code: 'E_HANDLER', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  cast(uiId: number, method: string, args: unknown[]): void {
    const set = this.listeners.get(method)
    if (!set) return
    for (const l of set) {
      // A cast has no reply channel (unlike dispatch, which returns E_HANDLER), so isolate each
      // listener: one throw must not skip the rest — e.g. a broken pty:write attribution listener
      // would otherwise swallow the user's keystrokes. Log it, keep going.
      try {
        if (l.withSender) l.fn(uiId, ...args)
        else l.fn(...args)
      } catch (err) {
        console.warn(
          `[nodeterm-server] cast listener for ${method} threw`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }
}
