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

/** The `[subsystem]` prefix convention: split it off the first arg when present. */
export function splitTag(first: unknown): { tag: string; rest: string } {
  if (typeof first === 'string') {
    const m = /^\[([^\]\n]{1,32})\]\s*/.exec(first)
    if (m) return { tag: m[1], rest: first.slice(m[0].length) }
    return { tag: '', rest: first }
  }
  return { tag: '', rest: formatArg(first) }
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
 */
export function installLogSink(buffer: LogBuffer): () => void {
  const originals = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error
  }
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    console[name] = (...args: unknown[]): void => {
      originals[name].apply(console, args)
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
  }
}
