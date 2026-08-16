import { describe, it, expect } from 'vitest'
import { LogBuffer, LOG_BUFFER_CAP, LOG_LINE_MAX } from './log-buffer'

const rec = (msg: string) => ({ level: 'info' as const, tag: 't', msg })

describe('LogBuffer', () => {
  it('assigns monotonic seqs and snapshots in order', () => {
    const b = new LogBuffer()
    b.push(rec('a'))
    b.push(rec('b'))
    const snap = b.snapshot()
    expect(snap.map((r) => r.msg)).toEqual(['a', 'b'])
    expect(snap[1].seq).toBeGreaterThan(snap[0].seq)
  })

  it('drops oldest past the cap — the ring never grows unbounded', () => {
    const b = new LogBuffer()
    for (let i = 0; i < LOG_BUFFER_CAP + 10; i++) b.push(rec(`m${i}`))
    const snap = b.snapshot()
    expect(snap.length).toBe(LOG_BUFFER_CAP)
    expect(snap[0].msg).toBe('m10')
    // seq keeps counting across drops — since() stays correct after eviction.
    expect(b.lastSeq()).toBe(LOG_BUFFER_CAP + 10)
  })

  it('since(seq) returns only newer records', () => {
    const b = new LogBuffer()
    b.push(rec('a'))
    const mark = b.lastSeq()
    b.push(rec('b'))
    b.push(rec('c'))
    expect(b.since(mark).map((r) => r.msg)).toEqual(['b', 'c'])
    expect(b.since(b.lastSeq())).toEqual([])
  })

  it('redacts at the push boundary — nothing unredacted ever exists in the ring', () => {
    const b = new LogBuffer()
    b.push(rec('NODETERM_HOOK_TOKEN=abc123'))
    expect(b.snapshot()[0].msg).toBe('NODETERM_HOOK_TOKEN=[redacted]')
  })

  it('caps a runaway line at LOG_LINE_MAX', () => {
    const b = new LogBuffer()
    b.push(rec('x'.repeat(LOG_LINE_MAX * 2)))
    expect(b.snapshot()[0].msg.length).toBeLessThanOrEqual(LOG_LINE_MAX + 1)
  })

  it('notifies onAppend, and a throwing listener does not break logging', () => {
    const b = new LogBuffer()
    let n = 0
    b.onAppend(() => {
      throw new Error('boom')
    })
    const un = b.onAppend(() => n++)
    b.push(rec('a'))
    expect(n).toBe(1)
    un()
    b.push(rec('b'))
    expect(n).toBe(1)
  })
})
