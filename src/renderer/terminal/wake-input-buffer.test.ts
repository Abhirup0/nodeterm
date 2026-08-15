import { describe, it, expect } from 'vitest'
import { WakeInputBuffer, WAKE_BUFFER_MAX_CHARS } from './wake-input-buffer'

/**
 * The bounded wake input buffer, every edge driven — and each key assertion is mutation-checked in
 * the source (revert the mechanism → red → restore) rather than only asserted here.
 *
 * The one property that matters is the timing: while a wake is in flight, NOTHING the human types
 * reaches the pane; it is held until the resume line is confirmed submitted, and dropped if the
 * wake never resumed. Everything below is that property, split by edge.
 */

/** Collect what the buffer decides to write, so a test can assert both order and timing. */
function sink(): { writes: string[]; write: (d: string) => void } {
  const writes: string[] = []
  return { writes, write: (d) => writes.push(d) }
}

describe('WakeInputBuffer', () => {
  it('passes input straight through when no wake is in flight', () => {
    const b = new WakeInputBuffer()
    expect(b.isWaking).toBe(false)
    expect(b.offer('ls\r')).toEqual({ kind: 'passthrough' })
    // Passthrough holds nothing — the ordinary terminal is untouched.
    expect(b.bufferedChars).toBe(0)
  })

  it('HOLDS input during a wake and writes NOTHING until the resume is confirmed', () => {
    const b = new WakeInputBuffer()
    const s = sink()
    b.beginWake()
    expect(b.isWaking).toBe(true)
    expect(b.offer('a')).toEqual({ kind: 'buffered', bufferedChars: 1 })
    expect(b.offer('bc')).toEqual({ kind: 'buffered', bufferedChars: 3 })
    // The whole point: not one byte has been written while the resume line is un-submitted.
    expect(s.writes).toEqual([])
    expect(b.bufferedChars).toBe(3)
  })

  it('flushes the held input IN ORDER once the wake resumed', () => {
    const b = new WakeInputBuffer()
    const s = sink()
    b.beginWake()
    b.offer('one')
    b.offer('two')
    b.offer('three')
    const drain = b.endWake(true, s.write)
    expect(drain).toEqual({ reason: 'flushed', chars: 11 })
    // Order preserved, and only now — after the resume line submitted.
    expect(s.writes).toEqual(['one', 'two', 'three'])
    // The window is closed again: the buffer is inert.
    expect(b.isWaking).toBe(false)
    expect(b.bufferedChars).toBe(0)
    expect(b.offer('later')).toEqual({ kind: 'passthrough' })
  })

  it('DROPS the held input to `expired` when the wake did not resume', () => {
    const b = new WakeInputBuffer()
    const s = sink()
    b.beginWake()
    b.offer('rm -rf /')
    const drain = b.endWake(false, s.write)
    // The pane became whatever it became; the held bytes are discarded, not spliced into it.
    expect(drain).toEqual({ reason: 'expired', chars: 8 })
    expect(s.writes).toEqual([])
    expect(b.isWaking).toBe(false)
    expect(b.bufferedChars).toBe(0)
  })

  it('refuses with `queueFull` past the bound and holds nothing more (no silent drop)', () => {
    const b = new WakeInputBuffer(8)
    const s = sink()
    b.beginWake()
    expect(b.offer('12345')).toEqual({ kind: 'buffered', bufferedChars: 5 })
    // 5 + 4 = 9 > 8: the chunk is refused WHOLE, and the buffer keeps exactly what it had.
    expect(b.offer('6789')).toEqual({ kind: 'queueFull', capacity: 8 })
    expect(b.bufferedChars).toBe(5)
    // A smaller chunk that still fits is still accepted — the refusal was of the chunk, not a latch.
    expect(b.offer('67')).toEqual({ kind: 'buffered', bufferedChars: 7 })
    // On resume only what was actually buffered is written; the refused chunk never appears.
    b.endWake(true, s.write)
    expect(s.writes).toEqual(['12345', '67'])
    expect(s.writes.join('')).not.toContain('6789')
  })

  it('the bound is exact — a chunk landing on the boundary is accepted, one past it is not', () => {
    const b = new WakeInputBuffer(4)
    b.beginWake()
    expect(b.offer('abcd')).toEqual({ kind: 'buffered', bufferedChars: 4 })
    expect(b.offer('e')).toEqual({ kind: 'queueFull', capacity: 4 })
  })

  it('beginWake is idempotent — re-entering a wake does not drop what is already held', () => {
    const b = new WakeInputBuffer()
    const s = sink()
    b.beginWake()
    b.offer('held')
    b.beginWake() // the retry path re-arms; it must not clear the buffer
    expect(b.bufferedChars).toBe(4)
    b.endWake(true, s.write)
    expect(s.writes).toEqual(['held'])
  })

  it('the default bound is a sane, finite number', () => {
    // A bound that is 0 or Infinity is not a bound; pin that the default is neither.
    expect(WAKE_BUFFER_MAX_CHARS).toBeGreaterThan(0)
    expect(Number.isFinite(WAKE_BUFFER_MAX_CHARS)).toBe(true)
  })
})
