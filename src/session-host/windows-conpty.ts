import fs from 'fs'
import type { Socket } from 'net'
import type { IPty } from 'node-pty'

export const SUPPORTED_WINDOWS_CONPTY_NODE_PTY_VERSION = '1.1.0'

const SAFE_CLOSE_ERROR = 'session-host could not safely close the Windows terminal'

type PrivateConptyNative = {
  startProcess: (...args: unknown[]) => unknown
  connect: (...args: unknown[]) => unknown
  resize: (...args: unknown[]) => unknown
  clear: (...args: unknown[]) => unknown
  /** Patched node-pty 1.1.0 returns true only when it found and closed this exact HPCON. */
  kill: (ptyId: number, useConptyDll: boolean) => unknown
}

type PrivateWindowsPtyAgent = {
  constructor: { name?: unknown }
  _useConpty: boolean
  _useConptyDll: boolean
  _pty: number
  _ptyNative: PrivateConptyNative
  _inSocket: Socket
  _outSocket: Socket
  _conoutSocketWorker: {
    constructor: { name?: unknown }
    _worker: { terminate: () => unknown }
    _drainTimeout?: ReturnType<typeof setTimeout>
    _isDisposed: boolean
  }
}

type PrivateWindowsTerminal = {
  constructor: { name?: unknown }
  _pty: number
  _isReady: boolean
  _deferreds: unknown[]
  _agent: PrivateWindowsPtyAgent
  _close: () => void
}

type CloseState = {
  terminal: PrivateWindowsTerminal
  release?: Promise<void>
}

const closeStates = new WeakMap<object, CloseState>()

function fail(): never {
  // This exception can cross the session-host protocol. Keep executable paths, argv, PIDs and
  // private-property diagnostics out of it; callers may add private local logging separately.
  throw new Error(SAFE_CLOSE_ERROR)
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

let installedNodePtyVersion: string | undefined

function nodePtyVersion(): string {
  if (installedNodePtyVersion !== undefined) return installedNodePtyVersion
  try {
    const packagePath = require.resolve('node-pty/package.json')
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as unknown
    if (!isRecord(parsed) || typeof parsed.version !== 'string') fail()
    installedNodePtyVersion = parsed.version
    return parsed.version
  } catch {
    fail()
  }
}

function hasNativeFunction(
  native: Record<PropertyKey, unknown>,
  name: keyof PrivateConptyNative
): boolean {
  return typeof native[name] === 'function'
}

function exactWindowsConpty(proc: IPty): PrivateWindowsTerminal {
  if (process.platform !== 'win32') fail()
  if (nodePtyVersion() !== SUPPORTED_WINDOWS_CONPTY_NODE_PTY_VERSION) fail()
  if (!isRecord(proc) || proc.constructor?.name !== 'WindowsTerminal') fail()

  const agent = proc._agent
  if (!isRecord(agent) || agent.constructor?.name !== 'WindowsPtyAgent') fail()
  if (agent._useConpty !== true || typeof agent._useConptyDll !== 'boolean') fail()
  if (typeof agent._pty !== 'number' || !Number.isSafeInteger(agent._pty) || agent._pty <= 0) {
    fail()
  }
  if (
    typeof proc._pty !== 'number' ||
    !Number.isSafeInteger(proc._pty) ||
    proc._pty !== agent._pty
  ) {
    fail()
  }
  if (typeof proc._isReady !== 'boolean' || !Array.isArray(proc._deferreds)) fail()

  const native = agent._ptyNative
  if (!isRecord(native)) fail()
  if (
    !hasNativeFunction(native, 'startProcess') ||
    !hasNativeFunction(native, 'connect') ||
    !hasNativeFunction(native, 'resize') ||
    !hasNativeFunction(native, 'clear') ||
    !hasNativeFunction(native, 'kill')
  ) {
    fail()
  }
  if (
    !isRecord(agent._inSocket) ||
    typeof agent._inSocket.destroy !== 'function' ||
    typeof agent._inSocket.once !== 'function' ||
    !isRecord(agent._outSocket) ||
    typeof agent._outSocket.destroy !== 'function' ||
    typeof agent._outSocket.once !== 'function'
  ) {
    fail()
  }
  const conout = agent._conoutSocketWorker
  if (
    !isRecord(conout) ||
    conout.constructor?.name !== 'ConoutConnection' ||
    typeof conout._isDisposed !== 'boolean' ||
    !isRecord(conout._worker) ||
    typeof conout._worker.terminate !== 'function' ||
    typeof proc._close !== 'function'
  ) {
    fail()
  }
  return proc as unknown as PrivateWindowsTerminal
}

/**
 * Close one node-pty 1.1.0 Windows pseudoconsole by its native PTY id, even before the first
 * output byte. This deliberately bypasses `WindowsTerminal.kill()` (which is deferred until first
 * data) and `WindowsPtyAgent.kill()` (which starts asynchronous console-process enumeration).
 *
 * The repository's version-pinned native patch changes `conpty.kill` to return `true` only after
 * it found this exact baton and synchronously called ClosePseudoConsole for its HPCON. `undefined`
 * is the stock 1.1.0 behavior and is rejected: it cannot distinguish a close from the shell-exit
 * race that already deleted the baton. The caller must still wait for the exact recorded process
 * identities to disappear before acknowledging a destructive operation.
 */
export function closeExactWindowsConpty(proc: IPty): void {
  const terminal = exactWindowsConpty(proc)
  if (closeStates.has(terminal as unknown as object)) fail()
  const agent = terminal._agent
  let closed: unknown
  try {
    closed = agent._ptyNative.kill.call(
      agent._ptyNative,
      agent._pty,
      agent._useConptyDll
    )
  } catch {
    fail()
  }
  if (closed !== true) fail()
  closeStates.set(terminal as unknown as object, { terminal })
}

function socketClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onClose = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(SAFE_CLOSE_ERROR))
    }
    const cleanup = (): void => {
      socket.removeListener('close', onClose)
      socket.removeListener('error', onError)
    }
    socket.once('close', onClose)
    socket.once('error', onError)
    try {
      socket.destroy()
    } catch {
      cleanup()
      reject(new Error(SAFE_CLOSE_ERROR))
    }
  })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === 'function'
}

/**
 * Finish the exact ConPTY's private transport teardown after the caller has independently proven
 * the shell process tree absent. The output socket is destroyed last because its `close` event is
 * node-pty's public `onExit`; by then the input handle and the exact ConoutConnection worker are
 * already gone, so a host cannot acknowledge through `onExit` while those resources remain live.
 */
export function releaseExactWindowsConpty(proc: IPty): Promise<void> {
  const state = closeStates.get(proc as unknown as object)
  if (!state || state.terminal !== (proc as unknown as PrivateWindowsTerminal)) {
    return Promise.reject(new Error(SAFE_CLOSE_ERROR))
  }
  if (state.release) return state.release

  state.release = (async () => {
    const terminal = state.terminal
    const agent = terminal._agent
    const conout = agent._conoutSocketWorker
    try {
      terminal._close()
      await socketClosed(agent._inSocket)

      if (conout._drainTimeout !== undefined) {
        clearTimeout(conout._drainTimeout)
        conout._drainTimeout = undefined
      }
      conout._isDisposed = true
      const terminated = conout._worker.terminate()
      if (!isPromiseLike(terminated)) fail()
      await terminated

      // This is the public exit-event commit point. Keep it after every awaited private cleanup.
      await socketClosed(agent._outSocket)
    } catch {
      fail()
    }
  })()
  return state.release
}
