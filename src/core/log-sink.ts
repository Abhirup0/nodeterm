import { inspect } from 'util'
import type { LogBuffer, LogRecord } from './log-buffer'

/**
 * Console capture for the debug log ring (issue #78). Packaged apps swallow the process console
 * entirely — this is the only place the app's own `console.warn('[tag] …')` calls become
 * observable in the field. The wrap forwards to the original console untouched (dev terminals
 * keep working), then mirrors a formatted line into the ring.
 */

const LEVEL: Record<string, LogRecord['level']> = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warn: 'warn',
  error: 'error'
}

type StdioName = 'stdout' | 'stderr'

/** Which stdio stream each console method writes to — node's own Console contract. */
const STREAM_OF: Record<keyof typeof LEVEL, StdioName> = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  warn: 'stderr',
  error: 'stderr'
}

/** The `[subsystem]` prefix convention: split it off the first arg when present. */
export function splitTag(first: unknown): { tag: string; rest: string } {
  if (typeof first === 'string') {
    const m = /^\[([^\]\n]{1,32})\]\s*/.exec(first)
    if (m) return { tag: m[1], rest: first.slice(m[0].length) }
    return { tag: '', rest: first }
  }
  return { tag: '', rest: formatArg(first) }
}

/** `EIO` / `EPIPE` / … when the failure carries one, else something printable. */
function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code ? code : String(e)
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? String(a)
  try {
    // util.inspect over JSON.stringify: it survives cycles and prints Errors usefully.
    return inspect(a, { depth: 3, breakLength: Infinity })
  } catch {
    return String(a)
  }
}

/**
 * Wrap the console methods so every call also lands in the ring. Returns an uninstaller that
 * restores the originals (tests; and the wrap must never stack twice).
 *
 * Also mirrors `uncaughtExceptionMonitor` — the MONITOR hook, deliberately: a plain
 * `process.on('uncaughtException')` listener changes crash semantics (the process no longer
 * dies), and a debug log must observe failures, not swallow them. There is no monitor
 * equivalent for 'unhandledRejection', and installing that listener suppresses the default
 * throw-on-unhandled behavior — so rejections are left alone here on purpose.
 *
 * **A dying stdio stream must not take the app with it** (issue #382: `write EIO` killed the
 * main process after the terminal a `npm start` was launched from went away — macOS `revoke()`s
 * the tty's fds, and every later `console.log` writes into a revoked descriptor). Two facts
 * decide the shape of the guard, and the first one is counter-intuitive:
 *
 * 1. **The error does NOT arrive as a throw at the call site.** When stdout is a pipe or a tty
 *    node writes it as a Socket, so the failure comes back through the write callback and is
 *    re-emitted as an `'error'` EVENT on `process.stdout` on a later tick. The stack it carries
 *    was captured at the write, which is why the report *looks* synchronous — measured on node
 *    22: a `try/catch` around `originals[name].apply(...)` catches nothing at all, and the
 *    process still dies. So the load-bearing half of the fix is an `'error'` listener on each
 *    stdio stream; the `try/catch` is only there for the stdout-is-a-plain-file shape, where
 *    node writes synchronously through `fs.writeSync` and a throw really can reach us.
 * 2. **A dead stream stays dead**, and every subsequent write raises the error again (29 of 31
 *    writes, measured). So the first failure LATCHES that stream off: forwarding stops, the ring
 *    keeps everything, and the app's own observability is untouched — which is the whole reason
 *    the ring exists. Any error latches, whatever its code; a stdio stream we could not write to
 *    is not one worth probing again for a dev convenience.
 *
 * The listener is global by nature — it also stops a crash from some other writer's failed
 * `process.stdout.write`. That is a strict improvement (the alternative is the default: die),
 * and it is removed again by the uninstaller.
 */
export function installLogSink(buffer: LogBuffer): () => void {
  const originals = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error
  }
  const dead: Record<StdioName, boolean> = { stdout: false, stderr: false }
  const note = (which: StdioName, why: string): void => {
    if (dead[which]) return
    dead[which] = true
    try {
      buffer.push({
        level: 'warn',
        tag: 'log-sink',
        msg: `console forwarding to ${which} disabled after a stream failure (${why}); the ring keeps logging`
      })
    } catch {
      /* see below — logging must never throw */
    }
  }
  const streams: Record<StdioName, NodeJS.WritableStream | undefined> = {
    stdout: process.stdout,
    stderr: process.stderr
  }
  const streamListeners: { which: StdioName; fn: (err: unknown) => void }[] = []
  for (const which of Object.keys(streams) as StdioName[]) {
    const stream = streams[which]
    if (!stream || typeof stream.on !== 'function') continue
    const fn = (err: unknown): void => note(which, errCode(err))
    stream.on('error', fn)
    streamListeners.push({ which, fn })
  }

  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    const which = STREAM_OF[name]
    console[name] = (...args: unknown[]): void => {
      if (!dead[which]) {
        try {
          originals[name].apply(console, args)
        } catch (e) {
          // Only the synchronous shape lands here (see the doc comment); the common one is the
          // stream 'error' event above. Either way the stream is done — never rethrow.
          note(which, errCode(e))
        }
      }
      try {
        const { tag, rest } = splitTag(args[0])
        const tail = args.slice(1).map(formatArg).join(' ')
        buffer.push({ level: LEVEL[name], tag, msg: tail ? `${rest} ${tail}` : rest })
      } catch {
        /* logging must never throw into the caller */
      }
    }
  }
  const onUncaught = (err: Error): void => {
    try {
      buffer.push({ level: 'error', tag: 'uncaught', msg: err?.stack ?? String(err) })
    } catch {
      /* see above */
    }
  }
  process.on('uncaughtExceptionMonitor', onUncaught)
  return () => {
    Object.assign(console, originals)
    process.removeListener('uncaughtExceptionMonitor', onUncaught)
    for (const { which, fn } of streamListeners) streams[which]?.removeListener('error', fn)
  }
}
