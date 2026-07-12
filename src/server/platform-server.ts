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

  // WS backpressure: per-session paused flag + the controller that pauses/resumes the pty.
  //
  // Keyed by sessionId ALONE, which co-attach (one pty, N subscribers) has made too coarse: a
  // session's pty:data now fans out to every subscribed ui, so this flag cannot express "behind
  // for browser A, flowing for browser B", and `flowController` pauses the ONE pty behind the
  // session for EVERYONE. Net effect today: one slow/backed-up browser pauses the shared pty for
  // all viewers (bounded — the pause is re-asserted per high send and resumes below LOW_WATER,
  // and PtyManager resumes on any subscriber change so nobody can be left frozen). Task 5 rekeys
  // this to (uiId, sessionId) and decides the pty-side policy (pause when ANY viewer is behind).
  private paused = new Map<string, boolean>()
  private flowController?: (sessionId: string, resume: boolean) => void

  setFlowController(fn: (sessionId: string, resume: boolean) => void): void {
    this.flowController = fn
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
        const isPaused = this.paused.get(sessionId) ?? false
        if (buffered > WS_HIGH_WATER) {
          // Re-assert the pause on EVERY high send (not just the rising edge). The
          // renderer's own xterm flow control drives the same setFlow actuator and may
          // have resumed the pty underneath us; an edge-latched `!isPaused` guard would
          // then never re-pause until the buffer drained to LOW. proc.pause() is
          // idempotent, and this branch only runs when data actually arrived (the pty was
          // running), so it self-limits — no spamming.
          this.paused.set(sessionId, true)
          this.flowController(sessionId, false)
        } else if (isPaused && buffered <= WS_LOW_WATER) {
          this.paused.set(sessionId, false)
          this.flowController(sessionId, true)
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
    // KNOWN WRONG, and knowingly left so — do not read this as a design.
    //
    // This clears the backpressure flags of EVERY connection, not just the departing one. It was
    // written when the Server Edition was single-UI ("every paused session belonged to the
    // departing connection"), which team presence has made false: two browsers are now a normal
    // configuration, and browser B disconnecting drops browser A's pause flags. The consequence is
    // bounded — a session A had paused is treated as unpaused, so the next high-water send
    // re-pauses it (sendTo re-asserts the pause on EVERY high send, not just the rising edge) —
    // but until then A can take one burst it should not have.
    //
    // The real fix is not a smaller patch here: `paused` is keyed by sessionId ALONE, so it cannot
    // represent "paused for A, flowing for B" at all, and neither can `flowController`, which
    // pauses the ONE tmux client behind that session. Stage 2 rekeys the map to (clientId,
    // sessionId) and decides the pty-side policy (pause when ANY viewer is behind); a half-fix here
    // — e.g. only clearing this uiId's entries — would silently leak a stale pause into the next
    // attach, which is worse than the over-clear.
    this.paused.clear()
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
