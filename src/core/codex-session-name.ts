/**
 * The desktop's client for the ONE shared `codex app-server`.
 *
 * Two jobs, both of which the sh launcher cannot do itself:
 *  - `startCodexThreadAt` — mint the thread a fresh Codex node will own.
 *  - `readCodexSessionName` — the READ leg of codex's session name (`TITLE_READ_CAPABLE`).
 *
 * The name lives in the app-server's `Thread.name`, not in a file on disk, so this is the only
 * place it can be read from. There is no WRITE leg: codex has no rename command NodeTerm can
 * drive, which is exactly the gemini situation `TITLE_READ_CAPABLE` was split out for.
 *
 * Everything here fails to `null`/reject rather than throwing into a caller's poll loop: a name we
 * cannot read means the node keeps its own title, and a thread we cannot start means the launcher
 * falls back to plain codex.
 */
import { homedir } from 'os'
import path from 'path'
import { WebSocket } from 'ws'

const SAFE_THREAD_ID = /^[A-Za-z0-9._-]+$/
const CACHE_MS = 3_000
const REQUEST_TIMEOUT_MS = 2_000
/** Minting a thread is a multi-step conversation with a cold server; it needs a real budget. */
const START_TIMEOUT_MS = 20_000

const names = new Map<string, { name: string | null; at: number }>()
const inflight = new Map<string, Promise<string | null>>()

/** The app-server's control socket, under the CLI's own `CODEX_HOME` (default `~/.codex`). */
export function defaultCodexAppServerSocket(): string {
  const configured = process.env.CODEX_HOME
  const codexHome =
    configured && path.isAbsolute(configured) ? configured : path.join(homedir(), '.codex')
  return path.join(codexHome, 'app-server-control', 'app-server-control.sock')
}

export function codexUnixWebSocketUrl(socketPath: string): string {
  if (!path.isAbsolute(socketPath) || /[\s:%?#]/.test(socketPath)) {
    throw new Error('Unsupported Codex app-server socket path')
  }
  return `ws+unix://${socketPath}:/rpc`
}

function connectCodexAppServer(socketPath: string): WebSocket {
  return new WebSocket(codexUnixWebSocketUrl(socketPath), { perMessageDeflate: false })
}

/** Seed the name cache from a name we were handed out of band (a hook, a bind). */
export function rememberCodexSessionName(
  threadId: string,
  name: unknown,
  socketPath = defaultCodexAppServerSocket()
): void {
  if (!threadId) return
  const value = typeof name === 'string' && name.trim() ? name.trim() : null
  names.set(`${socketPath}\0${threadId}`, { name: value, at: Date.now() })
}

export function readCodexSessionNameAt(
  socketPath: string,
  threadId: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<string | null> {
  if (!SAFE_THREAD_ID.test(threadId)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let ws: WebSocket
    const finish = (name: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      resolve(name)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm', version: '1' } }
        })
      )
    })
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) return finish(null)
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(
          JSON.stringify({
            id: 2,
            method: 'thread/read',
            params: { threadId, includeTurns: false }
          })
        )
      } else if (message.id === 2) {
        const name = message.result?.thread?.name
        finish(typeof name === 'string' && name.trim() ? name.trim() : null)
      }
    })
    ws.once('error', () => finish(null))
    ws.once('close', () => finish(null))
  })
}

/**
 * Create one new, immediately RESUMABLE thread on the shared app-server and return its id.
 *
 * `thread/start` alone only creates app-server metadata: it deliberately does not materialize the
 * rollout file, and a second client's `thread/resume` then fails with "no rollout found" — which
 * is precisely what the launcher does one line later. So the rollout is materialized by running
 * one empty turn, interrupting it the moment the server announces it, forking immediately BEFORE
 * that turn, and deleting the seed. The result is a thread with zero user turns and a valid
 * rollout, without the deprecated rollback API.
 */
export function startCodexThreadAt(
  socketPath: string,
  cwd: string,
  timeoutMs = START_TIMEOUT_MS
): Promise<string> {
  if (!path.isAbsolute(cwd) || cwd.includes('\0')) {
    return Promise.reject(new Error('Unsupported Codex thread cwd'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let ws: WebSocket
    const finish = (error: Error | null, threadId?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      if (error) reject(error)
      else resolve(threadId as string)
    }
    const timer = setTimeout(
      () => finish(new Error('Codex app-server thread start timed out')),
      timeoutMs
    )
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      reject(new Error('Codex app-server is unavailable'))
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'nodeterm', version: '1' },
            capabilities: { experimentalApi: true }
          }
        })
      )
    })
    let threadId = ''
    let bootstrapTurnId = ''
    let announcedBootstrapTurnId = ''
    let announcedCompletedTurnId = ''
    let bootstrapStarted = false
    let interruptSent = false
    let interruptAcknowledged = false
    let bootstrapCompleted = false
    let cleanupForkSent = false
    const maybeInterrupt = (): void => {
      if (!bootstrapTurnId || !bootstrapStarted || bootstrapCompleted || interruptSent) return
      interruptSent = true
      ws.send(
        JSON.stringify({
          id: 4,
          method: 'turn/interrupt',
          params: { threadId, turnId: bootstrapTurnId }
        })
      )
    }
    const maybeCreateCleanThread = (): void => {
      if (!bootstrapCompleted || cleanupForkSent) return
      if (interruptSent && !interruptAcknowledged) return
      cleanupForkSent = true
      ws.send(
        JSON.stringify({
          id: 5,
          method: 'thread/fork',
          params: { threadId, beforeTurnId: bootstrapTurnId, cwd, ephemeral: false }
        })
      )
    }
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error('Codex app-server initialization failed'))
          return
        }
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(JSON.stringify({ id: 2, method: 'thread/start', params: { cwd } }))
      } else if (message.id === 2) {
        const startedThreadId = message.result?.thread?.id
        if (
          message.error ||
          typeof startedThreadId !== 'string' ||
          !SAFE_THREAD_ID.test(startedThreadId)
        ) {
          finish(new Error('Codex app-server returned no valid thread identity'))
          return
        }
        threadId = startedThreadId
        ws.send(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId, input: [] } }))
      } else if (message.id === 3) {
        const turnId = message.result?.turn?.id
        if (message.error || typeof turnId !== 'string' || !SAFE_THREAD_ID.test(turnId)) {
          finish(new Error('Codex app-server could not materialize the new thread'))
          return
        }
        bootstrapTurnId = turnId
        if (announcedBootstrapTurnId === turnId) bootstrapStarted = true
        if (announcedCompletedTurnId === turnId) bootstrapCompleted = true
        maybeInterrupt()
        maybeCreateCleanThread()
      } else if (message.method === 'turn/started') {
        const turnId = message.params?.turn?.id
        if (typeof turnId === 'string') {
          announcedBootstrapTurnId = turnId
          if (turnId === bootstrapTurnId) {
            bootstrapStarted = true
            maybeInterrupt()
          }
        }
      } else if (message.id === 4) {
        if (message.error) {
          finish(new Error('Codex app-server could not interrupt thread materialization'))
          return
        }
        interruptAcknowledged = true
        maybeCreateCleanThread()
      } else if (message.method === 'turn/completed') {
        const turnId = message.params?.turn?.id
        if (typeof turnId === 'string') {
          announcedCompletedTurnId = turnId
          if (turnId === bootstrapTurnId) {
            bootstrapCompleted = true
            maybeCreateCleanThread()
          }
        }
      } else if (message.id === 5) {
        const readyThreadId = message.result?.thread?.id
        if (
          message.error ||
          typeof readyThreadId !== 'string' ||
          !SAFE_THREAD_ID.test(readyThreadId)
        ) {
          finish(new Error('Codex app-server could not clean up thread materialization'))
          return
        }
        const seedThreadId = threadId
        threadId = readyThreadId
        ws.send(JSON.stringify({ id: 6, method: 'thread/delete', params: { threadId: seedThreadId } }))
      } else if (message.id === 6) {
        if (message.error) {
          finish(new Error('Codex app-server could not remove thread materialization seed'))
          return
        }
        finish(null, threadId)
      }
    })
    ws.once('error', () => finish(new Error('Codex app-server is unavailable')))
    ws.once('close', () => finish(new Error('Codex app-server closed before thread start')))
  })
}

export function startCodexThread(cwd: string): Promise<string> {
  return startCodexThreadAt(defaultCodexAppServerSocket(), cwd)
}

/**
 * The READ leg for `TITLE_READ_CAPABLE`. Memoized for `CACHE_MS` and coalesced, because the
 * session-name sweep asks once a minute PER NODE and every ask is a socket connect.
 */
export function readCodexSessionName(
  threadId: string,
  socketPath = defaultCodexAppServerSocket()
): Promise<string | null> {
  if (!SAFE_THREAD_ID.test(threadId)) return Promise.resolve(null)
  const key = `${socketPath}\0${threadId}`
  const cached = names.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.name)
  const running = inflight.get(key)
  if (running) return running
  const request = readCodexSessionNameAt(socketPath, threadId).then(
    (name) => {
      names.set(key, { name, at: Date.now() })
      inflight.delete(key)
      return name
    },
    () => {
      inflight.delete(key)
      return null
    }
  )
  inflight.set(key, request)
  return request
}

export function forgetCodexSessionNames(): void {
  names.clear()
  inflight.clear()
}
