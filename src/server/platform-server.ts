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

/** The Linux-server CorePlatform: RPC registries + a WS-connection (UiSink) registry.
 *  One instance per server process; each authenticated WebSocket attaches as one UI. */
export class ServerPlatform implements CorePlatform {
  readonly userDataDir: string
  readonly appVersion: string
  readonly isPackaged = true

  private handlers = new Map<string, Handler>()
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  private senderListeners = new Map<string, Set<(senderId: number, ...args: any[]) => void>>()
  private sinks = new Map<number, UiSink>()
  private nextUiId = 1

  // WS backpressure: per-session paused flag + the controller that pauses/resumes the
  // tmux client. Keyed by sessionId alone (a session's pty:data always routes to one ui).
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
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(fn)
  }

  onWithSender(channel: string, fn: (senderId: number, ...args: any[]) => void): void {
    let set = this.senderListeners.get(channel)
    if (!set) {
      set = new Set()
      this.senderListeners.set(channel, set)
    }
    set.add(fn)
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
    // v1 is single-UI: every paused session belonged to the departing connection, so drop the
    // whole backpressure map to avoid a stale pause leaking into the next attach.
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
    const withSender = this.senderListeners.get(method)
    if (withSender) for (const fn of withSender) fn(uiId, ...args)
    const set = this.listeners.get(method)
    if (!set) return
    for (const fn of set) fn(...args)
  }
}
