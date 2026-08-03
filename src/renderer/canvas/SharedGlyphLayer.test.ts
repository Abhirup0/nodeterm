import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSharedGlyphContext,
  idsFromOrderSig,
  nodeOrderSig,
  nodeZFor,
  setNodeZOrder,
  setSharedGlyphCamera,
  sharedGlyphActive,
  subscribeNodeZOrder,
  useSharedGlyph
} from './SharedGlyphLayer'

// Only the PURE parts are unit-testable here: there is no WebGL2, no OffscreenCanvas and no
// layout in the node test environment, so the component, the rAF driver and the GL singleton are
// device-verified (T6 checklist). What IS covered is everything the other tasks build on: the
// order signature Canvas derives, the store transitions T5/T6 read, and the z-order map + its
// notification seam.

beforeEach(() => {
  // The store and the z map are module singletons; reset them explicitly so the tests are
  // order-independent.
  useSharedGlyph.setState({ enabled: false, generation: 0, failed: false })
  setNodeZOrder([])
})

describe('nodeOrderSig', () => {
  it('joins TERMINAL node ids in array order', () => {
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal' },
      { id: 'b', type: 'terminal' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['a', 'b'])
  })

  it('ignores every other node kind — only terminals own a grid', () => {
    const sig = nodeOrderSig([
      { id: 's1', type: 'sticky' },
      { id: 't1', type: 'terminal' },
      { id: 'g1', type: 'group' },
      { id: 't2', type: 'terminal' },
      { id: 'sub', type: 'subagent' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['t1', 't2'])
  })

  it('is order sensitive — a reorder must produce a different signature', () => {
    const a = nodeOrderSig([
      { id: 'x', type: 'terminal' },
      { id: 'y', type: 'terminal' }
    ])
    const b = nodeOrderSig([
      { id: 'y', type: 'terminal' },
      { id: 'x', type: 'terminal' }
    ])
    expect(a).not.toBe(b)
  })

  it('an untyped node is not a terminal (React Flow defaults type to "default")', () => {
    expect(nodeOrderSig([{ id: 'a' }])).toBe('')
  })

  it('round-trips the empty canvas as an EMPTY list, not a one-element list of ""', () => {
    const sig = nodeOrderSig([])
    expect(sig).toBe('')
    expect(idsFromOrderSig(sig)).toEqual([])
  })
})

describe('useSharedGlyph store', () => {
  it('starts off, ungenerated and unfailed — the default-mode user must see nothing', () => {
    expect(useSharedGlyph.getState()).toMatchObject({ enabled: false, generation: 0, failed: false })
    expect(sharedGlyphActive()).toBe(false)
  })

  it('bumpGeneration increments (the re-register signal)', () => {
    useSharedGlyph.getState().bumpGeneration()
    useSharedGlyph.getState().bumpGeneration()
    expect(useSharedGlyph.getState().generation).toBe(2)
  })

  it('markFailed flips failed AND bumps the generation, so one subscription wakes every node', () => {
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState().failed).toBe(true)
    expect(useSharedGlyph.getState().generation).toBe(1)
  })

  it('markFailed is idempotent — a second failure must not re-notify', () => {
    useSharedGlyph.getState().markFailed()
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState().generation).toBe(1)
  })

  it('sharedGlyphActive is enabled AND not failed', () => {
    useSharedGlyph.getState().setEnabled(true)
    expect(sharedGlyphActive()).toBe(true)
    useSharedGlyph.getState().markFailed()
    expect(sharedGlyphActive()).toBe(false)
  })

  it('setEnabled is change-gated and survives a disable/enable round trip', () => {
    // Disabling also drops the GPU context; with none created (node env) that is a no-op, and it
    // must not throw or disturb the flags.
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(true)
    expect(() => useSharedGlyph.getState().setEnabled(false)).not.toThrow()
    expect(sharedGlyphActive()).toBe(false)
    useSharedGlyph.getState().setEnabled(true)
    expect(sharedGlyphActive()).toBe(true)
  })

  it('setEnabled(false) after a failure keeps the session failed (no silent retry)', () => {
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().markFailed()
    useSharedGlyph.getState().setEnabled(false)
    useSharedGlyph.getState().setEnabled(true)
    expect(useSharedGlyph.getState().failed).toBe(true)
    expect(sharedGlyphActive()).toBe(false)
  })
})

describe('setNodeZOrder', () => {
  it('maps each id to its index — array order IS the paint order', () => {
    setNodeZOrder(['a', 'b', 'c'])
    expect(nodeZFor('a')).toBe(0)
    expect(nodeZFor('b')).toBe(1)
    expect(nodeZFor('c')).toBe(2)
  })

  it('an id it has never seen lands on TOP, not at 0', () => {
    // A node created between two order pushes is appended last on the canvas, so "topmost" is the
    // answer that matches what the user sees; 0 would flash it under every other terminal.
    setNodeZOrder(['a', 'b'])
    expect(nodeZFor('fresh')).toBe(2)
  })

  it('notifies subscribers when the order changes', () => {
    const seen = vi.fn()
    const unsub = subscribeNodeZOrder(seen)
    setNodeZOrder(['a'])
    setNodeZOrder(['a', 'b'])
    expect(seen).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('does NOT notify when the same order is pushed again', () => {
    setNodeZOrder(['a', 'b'])
    const seen = vi.fn()
    const unsub = subscribeNodeZOrder(seen)
    setNodeZOrder(['a', 'b'])
    expect(seen).not.toHaveBeenCalled()
    unsub()
  })

  it('stops notifying after unsubscribe', () => {
    const seen = vi.fn()
    subscribeNodeZOrder(seen)()
    setNodeZOrder(['z'])
    expect(seen).not.toHaveBeenCalled()
  })

  it('an emptied canvas clears the map', () => {
    setNodeZOrder(['a', 'b'])
    setNodeZOrder([])
    expect(nodeZFor('a')).toBe(0)
  })
})

describe('graceful degrade without a GPU', () => {
  it('getSharedGlyphContext returns null while the shared mode is off — no context is acquired', () => {
    expect(getSharedGlyphContext()).toBeNull()
  })

  it('returns null (rather than throwing) when WebGL2/OffscreenCanvas are unavailable', () => {
    useSharedGlyph.getState().setEnabled(true)
    expect(getSharedGlyphContext()).toBeNull()
  })

  it('returns null once the session has failed', () => {
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().markFailed()
    expect(getSharedGlyphContext()).toBeNull()
  })

  it('setSharedGlyphCamera is inert without a context', () => {
    expect(() => setSharedGlyphCamera({ x: 10, y: 20, zoom: 2 })).not.toThrow()
  })
})
