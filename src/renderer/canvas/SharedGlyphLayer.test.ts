import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  failSharedGlyph,
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

  it('elevates a SELECTED terminal above the unselected ones, wherever it sits in the array', () => {
    // React Flow's elevateNodesOnSelect (default on) lifts the selected node's DOM to z 1000; a
    // grid z that followed the array alone would leave its text under the other grid's plate.
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal' },
      { id: 'b', type: 'terminal', selected: true },
      { id: 'c', type: 'terminal' }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['a', 'c', 'b'])
  })

  it('keeps selected nodes in their own relative order (a multi-select is stable)', () => {
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal', selected: true },
      { id: 'b', type: 'terminal' },
      { id: 'c', type: 'terminal', selected: true }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['b', 'a', 'c'])
  })

  it('an all-selected canvas keeps plain array order', () => {
    const sig = nodeOrderSig([
      { id: 'a', type: 'terminal', selected: true },
      { id: 'b', type: 'terminal', selected: true }
    ])
    expect(idsFromOrderSig(sig)).toEqual(['a', 'b'])
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
  // The failure funnel warns by design; silence it here and assert the once-ness explicitly.
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

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

  it('markFailed is idempotent — a second failure must not re-notify or re-log', () => {
    useSharedGlyph.getState().markFailed()
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState().generation).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('markFailed goes through the SAME funnel as failSharedGlyph (no half-failed state)', () => {
    // The store action must not be a shortcut that flips the flag while the GPU context stays
    // held: it delegates, so the two entries are interchangeable and the second one is a no-op.
    failSharedGlyph('test')
    useSharedGlyph.getState().markFailed()
    expect(useSharedGlyph.getState()).toMatchObject({ failed: true, generation: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('disabling the mode bumps the generation — a disposed context must be announced', () => {
    // setEnabled(false) drops the context; every registered grid is now holding an inert handle
    // and would stay blank until it remounted without this signal.
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(false)
    expect(useSharedGlyph.getState().generation).toBe(2)
    // Change-gated: a repeated disable disposes nothing, so it announces nothing.
    useSharedGlyph.getState().setEnabled(false)
    expect(useSharedGlyph.getState().generation).toBe(2)
  })

  it('ENABLING the mode bumps the generation too — already-mounted terminals must join', () => {
    // The user flips the setting to Shared with a canvas full of live terminals. Each of them
    // subscribes to `generation` and re-evaluates its participation on a bump; without one here
    // they would keep painting through xterm's own renderer until they remounted (a project
    // switch), and the setting would look like it did nothing. The bump is the ONE signal in this
    // seam, so enabling rides it exactly like disposal does.
    expect(useSharedGlyph.getState().generation).toBe(0)
    useSharedGlyph.getState().setEnabled(true)
    expect(useSharedGlyph.getState()).toMatchObject({ enabled: true, generation: 1 })
  })

  it('an enable bump carries the NEW enabled flag in the SAME notification', () => {
    // A subscriber's first move is to ask `sharedGlyphActive()`. If `enabled` were written in a
    // separate set() from the generation, one of the two notifications would carry a state that
    // disagrees with the other and a node would decide on the stale half.
    const seen: { enabled: boolean; generation: number }[] = []
    const unsub = useSharedGlyph.subscribe((s) =>
      seen.push({ enabled: s.enabled, generation: s.generation })
    )
    useSharedGlyph.getState().setEnabled(true)
    unsub()
    expect(seen).toEqual([{ enabled: true, generation: 1 }])
  })

  it('a repeated enable is change-gated — no bump, no re-registration storm', () => {
    useSharedGlyph.getState().setEnabled(true)
    useSharedGlyph.getState().setEnabled(true)
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
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

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

  // The absence paths above are the easy half: every guard inside `createContext` RETURNS null.
  // A constructor that THROWS instead (a wedged/lost GPU process, a hardened environment that
  // raises on canvas construction) took a different route out of `ensureLiveContext` — up through
  // whichever node happened to ask for the context first. It must degrade identically.
  it('returns null (not a throw) when the OffscreenCanvas constructor THROWS rather than being absent', () => {
    const g = globalThis as unknown as Record<string, unknown>
    const hadDocument = 'document' in g
    const hadOffscreen = 'OffscreenCanvas' in g
    const prevDocument = g.document
    const prevOffscreen = g.OffscreenCanvas
    try {
      // `creationAttempted` latches after the first attempt so a machine without a GPU is never
      // asked twice; the teardown `markFailed()` runs is the only thing that clears it, and it is
      // the supported way to get a fresh attempt out of this module singleton.
      useSharedGlyph.getState().setEnabled(true)
      useSharedGlyph.getState().markFailed()
      useSharedGlyph.setState({ enabled: true, failed: false })
      warn.mockClear()

      // Past the `typeof document === 'undefined'` guard, so construction is actually attempted.
      g.document = { createElement: () => ({ style: {}, className: '' }) }
      g.OffscreenCanvas = class {
        constructor() {
          throw new Error('canvas construction refused')
        }
      }

      expect(getSharedGlyphContext()).toBeNull()
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('[glyphgrid]')
      // A construction throw is "not available here", NOT a session failure: flipping `failed`
      // would bump the generation and re-notify every registrant from inside the very call one of
      // them is making, and would additionally kill the mode for the rest of the app run.
      expect(useSharedGlyph.getState().failed).toBe(false)
    } finally {
      if (hadDocument) g.document = prevDocument
      else delete g.document
      if (hadOffscreen) g.OffscreenCanvas = prevOffscreen
      else delete g.OffscreenCanvas
      // Leave the latch clear so a later test is not silently short-circuited by this one.
      useSharedGlyph.getState().markFailed()
      useSharedGlyph.setState({ enabled: false, failed: false })
    }
  })
})
