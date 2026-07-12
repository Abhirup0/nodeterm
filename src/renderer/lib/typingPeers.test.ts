import { describe, it, expect } from 'vitest'
import {
  TYPING_DECAY_MS,
  dropTyping,
  markTyping,
  nextTypingSweepDelay,
  pruneTyping,
  typingClientIds,
  type TypingMarks
} from './typingPeers'

const NOW = 10_000

describe('markTyping (a typing patch is stamped on OUR clock, never the sender\'s)', () => {
  it('records the node the peer is typing into, stamped with the local receipt time', () => {
    // `at` is the local `now` we pass, NOT the host stamp that rode the wire.
    const marks = markTyping({}, 7, 'n1', NOW)
    expect(marks).toEqual({ 7: { nodeId: 'n1', at: NOW } })
  })

  it('replaces a peer\'s previous mark (one node at a time; the newest write wins)', () => {
    const marks = markTyping(markTyping({}, 7, 'n1', NOW - 900), 7, 'n2', NOW)
    expect(marks).toEqual({ 7: { nodeId: 'n2', at: NOW } })
  })

  it('does not mutate the map it is given (zustand state must stay immutable)', () => {
    const before: TypingMarks = { 7: { nodeId: 'n1', at: NOW - 10 } }
    const after = markTyping(before, 8, 'n1', NOW)
    expect(before).toEqual({ 7: { nodeId: 'n1', at: NOW - 10 } })
    expect(Object.keys(after)).toEqual(['7', '8'])
  })
})

describe('typingClientIds (who is typing into THIS node, right now)', () => {
  it('returns the peers typing into this node — never those typing elsewhere', () => {
    const marks: TypingMarks = {
      1: { nodeId: 'n1', at: NOW - 100 },
      2: { nodeId: 'n2', at: NOW - 100 }, // typing into another terminal
      3: { nodeId: 'n1', at: NOW - 50 }
    }
    expect(typingClientIds(marks, 'n1', NOW)).toEqual([1, 3])
  })

  it('decays a stale stamp (the ring is a live signal, not a history)', () => {
    const marks: TypingMarks = { 1: { nodeId: 'n1', at: NOW - TYPING_DECAY_MS - 1 } }
    expect(typingClientIds(marks, 'n1', NOW)).toEqual([])
  })

  it('keeps a stamp that is exactly at the decay edge', () => {
    const marks: TypingMarks = { 1: { nodeId: 'n1', at: NOW - TYPING_DECAY_MS } }
    expect(typingClientIds(marks, 'n1', NOW)).toEqual([1])
  })

  it('tolerates a mark stamped slightly in the future (a clock that stepped back mid-session)', () => {
    const marks: TypingMarks = { 1: { nodeId: 'n1', at: NOW + 5 } }
    expect(typingClientIds(marks, 'n1', NOW)).toEqual([1])
  })

  it('orders by clientId (join order), so a chip never jumps as peers keep typing', () => {
    const marks: TypingMarks = {
      9: { nodeId: 'n1', at: NOW - 10 },
      2: { nodeId: 'n1', at: NOW - 1_900 }
    }
    expect(typingClientIds(marks, 'n1', NOW)).toEqual([2, 9])
  })

  it('allocates nothing when nobody is typing (this runs per node on every store write)', () => {
    // Identity, not just emptiness: the same frozen array every time, so useShallow bails out.
    expect(typingClientIds({}, 'n1', NOW)).toBe(typingClientIds({}, 'n2', NOW))
  })
})

describe('pruneTyping / nextTypingSweepDelay (the local decay timer)', () => {
  it('drops the marks that have decayed and keeps the live ones', () => {
    const marks: TypingMarks = {
      1: { nodeId: 'n1', at: NOW - TYPING_DECAY_MS - 1 },
      2: { nodeId: 'n1', at: NOW - 10 }
    }
    expect(pruneTyping(marks, NOW)).toEqual({ 2: { nodeId: 'n1', at: NOW - 10 } })
  })

  it('returns the SAME map when nothing decayed (no state write, no re-render)', () => {
    const marks: TypingMarks = { 2: { nodeId: 'n1', at: NOW - 10 } }
    expect(pruneTyping(marks, NOW)).toBe(marks)
  })

  it('sweeps at the earliest expiry, so the ring fades ~TYPING_DECAY_MS after the last keystroke', () => {
    const marks: TypingMarks = {
      1: { nodeId: 'n1', at: NOW - 1_500 },
      2: { nodeId: 'n2', at: NOW - 500 }
    }
    expect(nextTypingSweepDelay(marks, NOW)).toBe(TYPING_DECAY_MS - 1_500)
  })

  it('asks for no timer at all when nobody is typing — a solo user pays nothing', () => {
    expect(nextTypingSweepDelay({}, NOW)).toBeNull()
  })

  it('never asks for a negative delay (an already-expired mark sweeps immediately)', () => {
    const marks: TypingMarks = { 1: { nodeId: 'n1', at: NOW - TYPING_DECAY_MS - 5_000 } }
    expect(nextTypingSweepDelay(marks, NOW)).toBe(0)
  })
})

describe('dropTyping (a peer left)', () => {
  it('removes the peer\'s mark', () => {
    const marks: TypingMarks = { 1: { nodeId: 'n1', at: NOW }, 2: { nodeId: 'n1', at: NOW } }
    expect(dropTyping(marks, 1)).toEqual({ 2: { nodeId: 'n1', at: NOW } })
  })

  it('returns the SAME map for a peer that was not typing (no needless state write)', () => {
    const marks: TypingMarks = { 1: { nodeId: 'n1', at: NOW } }
    expect(dropTyping(marks, 99)).toBe(marks)
  })
})
