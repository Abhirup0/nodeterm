// WebSocket bridge that reconstructs `window.nodeTerminal` in the browser (Server Edition).
//
// Under Electron the preload already defines `window.nodeTerminal`; this module only runs when
// it is absent (see main.tsx's bootstrap switch). It opens ONE WebSocket to `/ws`, speaks the
// Task-1 RPC protocol (`parseRpcMessage` / `decodePtyData`), and rebuilds the three real
// namespaces (`pty`, `workspace`, `settings`) over that socket. Every other namespace comes from
// `buildStubApi()` (Task 7) so the renderer boots without a full Electron preload.

import { parseRpcMessage, decodePtyData, type RpcMessage } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import type {
  NodeTerminalApi,
  PtyApi,
  PtyCreateOptions,
  SettingsApi,
  Settings,
  Workspace,
  WorkspaceApi
} from '../../shared/types'
import { buildStubApi } from './stubs'

type Listener = (...args: unknown[]) => void

/**
 * One WebSocket, a pending-request map keyed by an incrementing id, and a channel-listener
 * fan-out map. Exported for the unit test (`ws-bridge.test.ts`). Kept free of any DOM/overlay
 * concerns so the test stays clean — reconnect UI lives in `installWsBridge`.
 */
export class RpcClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private channels = new Map<string, Set<Listener>>()
  // Events that arrived before any subscriber existed for their channel. The server can push an
  // event in the same macrotask as `open`, so a subscriber registered one microtask later (via
  // `await ready()`) would otherwise miss it. Buffered here (capped) and flushed on subscribe.
  private early: Array<{ channel: string; args: unknown[] }> = []
  private readyPromise: Promise<void>
  private closeCbs = new Set<() => void>()

  constructor(url: string) {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.readyPromise = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('WebSocket error')))
    })
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev.data))
    ws.addEventListener('close', () => this.closeCbs.forEach((cb) => cb()))
  }

  /** Resolves once the socket is open; rejects if it errors before opening. */
  ready(): Promise<void> {
    return this.readyPromise
  }

  /** Register a connection-loss hook (used by the reconnect overlay). */
  onClose(cb: () => void): void {
    this.closeCbs.add(cb)
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      const m = parseRpcMessage(data)
      if (!m) return
      this.handleJson(m)
      return
    }
    // Binary pty frame. Browser gives ArrayBuffer (binaryType='arraybuffer'); the `ws` package
    // in tests gives a Buffer (already a Uint8Array). Normalize both to a Uint8Array.
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : null
    if (!bytes) return
    const decoded = decodePtyData(bytes)
    if (!decoded) return
    this.fanOut(IPC.ptyData(decoded.sessionId), [decoded.data])
  }

  private handleJson(m: RpcMessage): void {
    if (m.t === 'res') {
      const entry = this.pending.get(m.id)
      if (!entry) return
      this.pending.delete(m.id)
      if (m.ok) entry.resolve(m.result)
      else entry.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
    } else if (m.t === 'ev') {
      this.fanOut(m.channel, m.args)
    }
  }

  private fanOut(channel: string, args: unknown[]): void {
    const set = this.channels.get(channel)
    if (!set || set.size === 0) {
      // No subscriber yet — buffer for replay on the first subscribe (capped, drop oldest).
      this.early.push({ channel, args })
      if (this.early.length > 4096) this.early.shift()
      return
    }
    for (const fn of set) fn(...args)
  }

  /** Send a request and resolve with its result (or reject with the coded error). */
  request(method: string, ...args: unknown[]): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ t: 'req', id, method, args }))
    })
  }

  /** Send a fire-and-forget cast (no response expected). */
  cast(method: string, ...args: unknown[]): void {
    this.ws.send(JSON.stringify({ t: 'cast', method, args }))
  }

  /** Subscribe to a channel; returns an unsubscribe function. */
  subscribe(channel: string, fn: Listener): () => void {
    let set = this.channels.get(channel)
    if (!set) {
      set = new Set()
      this.channels.set(channel, set)
    }
    set.add(fn)
    // Flush any events that arrived for this channel before it had a subscriber.
    if (this.early.length > 0) {
      const pending = this.early.filter((e) => e.channel === channel)
      if (pending.length > 0) {
        this.early = this.early.filter((e) => e.channel !== channel)
        for (const e of pending) fn(...e.args)
      }
    }
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.channels.delete(channel)
    }
  }
}

const AI_NAMING_UNAVAILABLE = {
  ok: false as const,
  message: 'AI naming is not available in the server edition yet'
}

/** Build the three real namespaces (`pty`, `workspace`, `settings`) over an RpcClient, mirroring
 *  the preload's invoke(→request)/send(→cast) split exactly. */
function buildRealApi(client: RpcClient): Pick<NodeTerminalApi, 'pty' | 'workspace' | 'settings'> {
  const pty: PtyApi = {
    create: (options: PtyCreateOptions) =>
      client.request(IPC.ptyCreate, options) as ReturnType<PtyApi['create']>,
    write: (sessionId, data) => client.cast(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => client.cast(IPC.ptyResize, sessionId, cols, rows),
    setFlow: (sessionId, resume) => client.cast(IPC.ptyFlow, sessionId, resume),
    kill: (sessionId) => client.cast(IPC.ptyKill, sessionId),
    destroy: (persistKey) => client.cast(IPC.ptyDestroy, persistKey),
    // No server handler — degrade gracefully (never reject the boot path).
    generateName: () => Promise.resolve(AI_NAMING_UNAVAILABLE),
    generateGroupName: () => Promise.resolve(AI_NAMING_UNAVAILABLE),
    capture: (persistKey, full) =>
      client.request(IPC.ptyCapture, persistKey, full).catch(() => '') as Promise<string>,
    readScrollback: (persistKey) =>
      client.request(IPC.ptyReadScrollback, persistKey) as Promise<string>,
    sendText: (persistKey, text) =>
      client.request(IPC.ptySendText, persistKey, text) as Promise<boolean>,
    // No server handler — the session-name poll degrades to no adopted name.
    readSessionName: () => Promise.resolve(''),
    onData: (sessionId, listener) =>
      client.subscribe(IPC.ptyData(sessionId), listener as Listener),
    onExit: (sessionId, listener) =>
      client.subscribe(IPC.ptyExit(sessionId), listener as Listener)
  }

  const workspace: WorkspaceApi = {
    load: () => client.request(IPC.workspaceLoad) as Promise<Workspace>,
    save: (ws: Workspace) => client.request(IPC.workspaceSave, ws) as Promise<void>
  }

  const settings: SettingsApi = {
    load: () => client.request(IPC.settingsLoad) as Promise<Settings>,
    save: (s: Settings) => client.request(IPC.settingsSave, s) as Promise<void>
  }

  return { pty, workspace, settings }
}

/** WS URL for the current page: same host, `/ws`, ws→http / wss→https. */
function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

// ── Reconnect overlay (kept out of RpcClient's unit-tested core) ────────────────────────────
const OVERLAY_ID = 'nt-reconnect-overlay'

function showReconnectOverlay(): void {
  if (typeof document === 'undefined' || document.getElementById(OVERLAY_ID)) return
  const el = document.createElement('div')
  el.id = OVERLAY_ID
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,0.72);color:#fff;' +
    'font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px'
  el.textContent = 'Bağlantı koptu — yeniden bağlanılıyor…'
  document.body.appendChild(el)
}

/** Retry the WS with backoff (1s→2s→4s→…→10s cap). On the first successful reopen, reload the
 *  page (the reloaded app re-runs `pty.create` per node with the same persistKey → tmux warm
 *  reattach). After 3 consecutive failed retries, bounce to `/login` (assume auth expired). */
function startReconnect(): void {
  showReconnectOverlay()
  let attempt = 0
  let failures = 0

  const tryOnce = (): void => {
    let probe: WebSocket
    try {
      probe = new WebSocket(wsUrl())
    } catch {
      scheduleRetry()
      return
    }
    probe.binaryType = 'arraybuffer'
    const cleanup = (): void => {
      probe.onopen = null
      probe.onerror = null
      probe.onclose = null
    }
    probe.onopen = () => {
      cleanup()
      try {
        probe.close()
      } catch {
        /* ignore */
      }
      location.reload()
    }
    probe.onerror = () => {
      // Let onclose drive the retry/failure counting (fires after error).
    }
    probe.onclose = () => {
      cleanup()
      failures++
      if (failures >= 3) {
        location.href = '/login'
        return
      }
      scheduleRetry()
    }
  }

  const scheduleRetry = (): void => {
    const delay = Math.min(1000 * 2 ** attempt, 10000)
    attempt++
    setTimeout(tryOnce, delay)
  }

  scheduleRetry()
}

/**
 * Connect the WS bridge and install `window.nodeTerminal`. Awaited by main.tsx's bootstrap
 * before the app boots, so the real namespaces are present on first render.
 */
export async function installWsBridge(): Promise<void> {
  const client = new RpcClient(wsUrl())
  await client.ready()
  client.onClose(() => startReconnect())
  const api: NodeTerminalApi = {
    ...buildStubApi(),
    ...buildRealApi(client)
  }
  ;(window as unknown as { nodeTerminal: NodeTerminalApi }).nodeTerminal = api
}
