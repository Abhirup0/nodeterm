/**
 * The ONE wrapper around `debugger.sendCommand`. Every CDP command the app ever issues to a guest
 * goes through here and through `checkCdpCommand` first — that is what makes the allowlist THE gate
 * rather than one of several. A structural test (browser-cdp-allowlist.test.ts) fails the build if a
 * `sendCommand(` appears in any other `src/main/browser-*.ts`.
 *
 * Default-deny: a command the allowlist refuses never reaches the debugger; the caller gets a NAMED
 * rejection, not a silent drop and not a raw Electron error.
 */
import { checkCdpCommand, type CdpContext } from './browser-cdp-allowlist'

/** The slice of Electron's `webContents.debugger` this layer needs, injected so the wrapper and the
 *  lease are unit-testable without Electron (`src/main` cannot import the real module under vitest). */
export interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: object, sessionId?: string): Promise<unknown>
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
}

/** A refused command names the method — but never WHY, and never per-method detail: an allowlist
 *  that explains itself is a probing aid. One line, like every control reply. */
export const cdpRefusedMessage = (method: string): string =>
  `browser: the command ${method} is not permitted for agent control`

/**
 * Check, then send. The single choke point. `sessionId` targets a flat-mode child session; omitting
 * it targets the root. Throws `Error(cdpRefusedMessage(method))` — a rejected promise, never a hang —
 * when the allowlist refuses, so the refusal is a first-class outcome the caller must handle.
 */
export function sendCdp(
  dbg: DebuggerLike,
  method: string,
  params: object,
  ctx: CdpContext,
  sessionId?: string
): Promise<unknown> {
  if (!checkCdpCommand(method, params, ctx)) {
    return Promise.reject(new Error(cdpRefusedMessage(method)))
  }
  return dbg.sendCommand(method, params, sessionId)
}
