import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakePlatform } from './platform-fake'
import { LogBuffer } from './log-buffer'
import { registerLogHandlers, LOG_PUSH_DEBOUNCE_MS } from './log-handlers'
import { installLogSink, splitTag } from './log-sink'
import { IPC } from '../shared/ipc'

const rec = (msg: string) => ({ level: 'info' as const, tag: 't', msg })
const batches = (f: ReturnType<typeof fakePlatform>) =>
  f.sent.filter((s) => s.channel === IPC.logBatch).map((s) => s.args[0] as { msg: string }[])

describe('registerLogHandlers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('pushes nothing while no panel is subscribed — the ring fills silently', () => {
    const f = fakePlatform()
    const b = new LogBuffer()
    registerLogHandlers(f, b, () => true)
    b.push(rec('a'))
    vi.advanceTimersByTime(LOG_PUSH_DEBOUNCE_MS * 2)
    expect(batches(f)).toEqual([])
    expect((f.handlers[IPC.logSnapshot]() as { msg: string }[]).map((r) => r.msg)).toEqual(['a'])
  })

  it('batches pushes while subscribed, starting from the subscribe point', () => {
    const f = fakePlatform()
    const b = new LogBuffer()
    registerLogHandlers(f, b, () => true)
    b.push(rec('before'))
    f.listeners[IPC.logSubscribe]()
    b.push(rec('x'))
    b.push(rec('y'))
    vi.advanceTimersByTime(LOG_PUSH_DEBOUNCE_MS + 10)
    expect(batches(f)).toEqual([[expect.objectContaining({ msg: 'x' }), expect.objectContaining({ msg: 'y' })]])
  })

  it('stops pushing after the last unsubscribe and when the setting is off', () => {
    const f = fakePlatform()
    const b = new LogBuffer()
    let on = true
    registerLogHandlers(f, b, () => on)
    f.listeners[IPC.logSubscribe]()
    f.listeners[IPC.logUnsubscribe]()
    b.push(rec('a'))
    vi.advanceTimersByTime(LOG_PUSH_DEBOUNCE_MS * 2)
    expect(batches(f)).toEqual([])

    f.listeners[IPC.logSubscribe]()
    on = false
    b.push(rec('b'))
    vi.advanceTimersByTime(LOG_PUSH_DEBOUNCE_MS * 2)
    expect(batches(f)).toEqual([])
  })

  it('logClear empties the ring', () => {
    const f = fakePlatform()
    const b = new LogBuffer()
    registerLogHandlers(f, b, () => true)
    b.push(rec('a'))
    f.listeners[IPC.logClear]()
    expect(f.handlers[IPC.logSnapshot]()).toEqual([])
  })
})

describe('installLogSink', () => {
  it('mirrors console calls into the ring with the [tag] convention, and uninstalls cleanly', () => {
    const b = new LogBuffer()
    const orig = console.warn
    const un = installLogSink(b)
    console.warn('[updater] check failed', new Error('offline'))
    un()
    expect(console.warn).toBe(orig)
    const snap = b.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0].level).toBe('warn')
    expect(snap[0].tag).toBe('updater')
    expect(snap[0].msg).toContain('check failed')
    expect(snap[0].msg).toContain('offline')
    // Nothing logged after uninstall.
    console.warn = orig
  })

  it('splitTag handles the untagged and non-string cases', () => {
    expect(splitTag('[main] hello')).toEqual({ tag: 'main', rest: 'hello' })
    expect(splitTag('plain line')).toEqual({ tag: '', rest: 'plain line' })
    expect(splitTag(42)).toEqual({ tag: '', rest: '42' })
  })

  // Issue #382: the terminal an `npm start` was launched from goes away, macOS revokes the tty
  // fds, and the next console.log kills the main process. The failure is delivered as an 'error'
  // EVENT on the stream (measured on node 22 — a try/catch at the call site catches nothing), so
  // these drive it the way node does.
  describe('a dying stdio stream', () => {
    const eio = (): NodeJS.ErrnoException => Object.assign(new Error('write EIO'), { code: 'EIO' })

    it("stops forwarding to a stream that emitted 'error' — that stream only — and keeps the ring", () => {
      const b = new LogBuffer()
      const out = vi.fn()
      const err = vi.fn()
      const origLog = console.log
      const origError = console.error
      console.log = out
      console.error = err
      const un = installLogSink(b)
      try {
        console.log('before')
        process.stdout.emit('error', eio())
        console.log('after')
        console.error('stderr still works')
      } finally {
        un()
        console.log = origLog
        console.error = origError
      }
      expect(out).toHaveBeenCalledTimes(1)
      expect(err).toHaveBeenCalledTimes(1)
      const msgs = b.snapshot().map((r) => r.msg)
      expect(msgs).toContain('before')
      expect(msgs).toContain('after')
      expect(msgs).toContain('stderr still works')
      expect(msgs.some((m) => m.includes('forwarding to stdout disabled') && m.includes('EIO'))).toBe(true)
    })

    it('swallows a synchronous write failure instead of letting it reach the caller', () => {
      const b = new LogBuffer()
      const origLog = console.log
      let calls = 0
      console.log = () => {
        calls++
        throw eio()
      }
      const un = installLogSink(b)
      try {
        expect(() => console.log('boom')).not.toThrow()
        console.log('again')
      } finally {
        un()
        console.log = origLog
      }
      // Latched after the first failure: the second call never reached the broken original.
      expect(calls).toBe(1)
      expect(b.snapshot().map((r) => r.msg)).toContain('again')
    })

    it('removes its stream listeners on uninstall', () => {
      const b = new LogBuffer()
      const before = process.stdout.listenerCount('error')
      const un = installLogSink(b)
      expect(process.stdout.listenerCount('error')).toBe(before + 1)
      un()
      expect(process.stdout.listenerCount('error')).toBe(before)
    })
  })
})
