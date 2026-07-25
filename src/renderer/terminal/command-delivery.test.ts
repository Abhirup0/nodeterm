import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_ATTEMPTS,
  VERIFY_TIMEOUT_MS,
  cleanEcho,
  deliverCommand,
  echoedIntact
} from './command-delivery'

const CMD = `claude --settings x 'implement the rerank feature for search results' --permission-mode auto`

function fakeIo() {
  const writes: string[] = []
  let cb: ((chunk: string) => void) | undefined
  return {
    writes,
    emit: (chunk: string) => cb?.(chunk),
    io: {
      write: (d: string) => writes.push(d),
      onData: (fn: (chunk: string) => void) => {
        cb = fn
        return () => {
          cb = undefined
        }
      }
    }
  }
}

/** A transport that echoes back from INSIDE write() — the shape the in-place restart
 *  choreography feeds deliverCommand. Every other case here uses an io that never echoes on
 *  write, so only this one can catch a re-entrant submit. */
function echoingIo() {
  const writes: string[] = []
  let cb: ((chunk: string) => void) | undefined
  return {
    writes,
    io: {
      write: (d: string) => {
        writes.push(d)
        cb?.(d)
      },
      onData: (fn: (chunk: string) => void) => {
        cb = fn
        return () => {
          cb = undefined
        }
      }
    }
  }
}

describe('cleanEcho', () => {
  it('strips CSI, OSC and other escape sequences plus line breaks', () => {
    const noisy = '\x1b[1;32mprompt\x1b[0m \x1b]0;title\x07ec' + '\r\n' + 'ho text\x1b[K'
    expect(cleanEcho(noisy)).toBe('prompt echo text')
  })
})

describe('echoedIntact', () => {
  it('matches on the command tail, tolerating junk before it', () => {
    expect(echoedIntact(`% ${CMD}`, CMD)).toBe(true)
  })
  it('does not match a truncated echo (flush ate the tail)', () => {
    expect(echoedIntact(CMD.slice(0, -6), CMD)).toBe(false)
  })
})

describe('deliverCommand', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes the command without Enter, then submits once the echo confirms it', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    expect(f.writes).toEqual([CMD])
    // Echo arrives in chunks, wrapped with \r\n and colored — still recognized.
    f.emit('\x1b[32m% \x1b[0m' + CMD.slice(0, 40) + '\r\n')
    f.emit(CMD.slice(40))
    expect(f.writes).toEqual([CMD, '\r'])
  })

  it('kills the line and rewrites when the echo never completes, then succeeds', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD.slice(0, 30)) // the tty flush ate the rest
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    expect(f.writes).toEqual([CMD, '\x15', CMD])
    f.emit(CMD) // clean echo on attempt 2
    expect(f.writes).toEqual([CMD, '\x15', CMD, '\r'])
  })

  it('fails open: after the last attempt times out it submits unverified', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    // attempt 1..N writes, N-1 kill-lines between them, final bare Enter.
    expect(f.writes.filter((w) => w === CMD)).toHaveLength(DELIVERY_ATTEMPTS)
    expect(f.writes.filter((w) => w === '\x15')).toHaveLength(DELIVERY_ATTEMPTS - 1)
    expect(f.writes[f.writes.length - 1]).toBe('\r')
  })

  it('cancel stops timers and listeners cold', () => {
    const f = fakeIo()
    const cancel = deliverCommand(f.io, CMD)
    cancel()
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD])
  })

  it('submits once against an io that echoes synchronously inside write', () => {
    const f = echoingIo()
    deliverCommand(f.io, CMD)
    // The echo lands while write() is still on the stack: submit must already be closed, or it
    // re-enters this listener (the tail still matches) and Enters forever.
    expect(f.writes).toEqual([CMD, '\r'])
    expect(f.writes.filter((w) => w === '\r')).toHaveLength(1)
    // ...and a delivery finished inside write() must leave no verify timer behind.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('announces the end of the delivery exactly once, however it ends', () => {
    // Verified submit.
    const a = fakeIo()
    let ends = 0
    deliverCommand(a.io, CMD, () => (ends += 1))
    expect(ends).toBe(0) // started, but the line is still un-submitted in the pane
    a.emit(CMD)
    expect(ends).toBe(1)
    a.emit(CMD) // late echo
    expect(ends).toBe(1)

    // Fail-open submit after the last attempt.
    const b = fakeIo()
    ends = 0
    deliverCommand(b.io, CMD, () => (ends += 1))
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(ends).toBe(1)

    // Cancelled (node teardown), and a repeat cancel must not announce twice.
    const c = fakeIo()
    ends = 0
    const cancel = deliverCommand(c.io, CMD, () => (ends += 1))
    cancel()
    cancel()
    expect(ends).toBe(1)
  })

  it('ignores echo arriving after submit (no double Enter)', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD, '\r'])
  })
})
