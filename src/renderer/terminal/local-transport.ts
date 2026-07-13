import type { NodeTerminalApi, PtyCreateOptions, PtyCreateResult, RecycledInfo } from '@shared/types'
import type { ClientId } from '@shared/presence'
import type { TerminalTransport } from './transport'

/**
 * Local transport: binds a core's api (`api.pty`) to the TerminalTransport interface.
 * The api is injected — for the local session it IS `window.nodeTerminal` (the preload
 * IPC surface; all real work happens in node-pty in the main process), so behavior is
 * identical to the pre-injection global reads.
 */
export class LocalTransport implements TerminalTransport {
  /** Lazy `window.nodeTerminal` fallback (not an eager default parameter): the module-scope
   *  `transport` singleton below is constructed at import time, and under node (vitest, no
   *  jsdom) `window` doesn't exist yet — it must only be touched on first use. */
  constructor(private readonly injectedApi?: NodeTerminalApi) {}

  private get api(): NodeTerminalApi {
    return this.injectedApi ?? window.nodeTerminal
  }

  private get pty() {
    return this.api.pty
  }

  create(options: PtyCreateOptions): Promise<PtyCreateResult> {
    return this.pty.create(options)
  }

  write(sessionId: string, data: string): void {
    this.pty.write(sessionId, data)
  }

  resize(sessionId: string, cols: number | null, rows: number | null): void {
    this.pty.resize(sessionId, cols, rows)
  }

  setFlow(sessionId: string, resume: boolean): void {
    this.pty.setFlow(sessionId, resume)
  }

  kill(sessionId: string): void {
    this.pty.kill(sessionId)
  }

  destroy(persistKey: string): void {
    this.pty.destroy(persistKey)
  }

  recycle(persistKey: string): void {
    this.pty.recycle(persistKey)
  }

  onData(sessionId: string, listener: (data: string) => void): () => void {
    return this.pty.onData(sessionId, listener)
  }

  onExit(sessionId: string, listener: (exitCode: number) => void): () => void {
    return this.pty.onExit(sessionId, listener)
  }

  onSize(sessionId: string, listener: (size: { cols: number; rows: number }) => void): () => void {
    return this.pty.onSize(sessionId, listener)
  }

  onClosed(sessionId: string, listener: (info: { by: ClientId | null }) => void): () => void {
    return this.pty.onClosed(sessionId, listener)
  }

  onRecycled(sessionId: string, listener: (info: RecycledInfo) => void): () => void {
    return this.pty.onRecycled(sessionId, listener)
  }

  onResync(sessionId: string, listener: (screen: string) => void): () => void {
    return this.pty.onResync(sessionId, listener)
  }
}

/** The single transport instance used by the app. Becomes selectable later. */
export const transport: TerminalTransport = new LocalTransport()
