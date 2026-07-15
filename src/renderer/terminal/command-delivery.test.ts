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

  it('ignores echo arriving after submit (no double Enter)', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD, '\r'])
  })
})
