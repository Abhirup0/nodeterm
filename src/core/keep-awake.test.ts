import { describe, expect, it } from 'vitest'
import { createKeepAwake, type KeepAwakeEdge, type KeepAwakeOpts } from './keep-awake'

/** A tracker over counting seams. `enabled`/`remote` are live-mutable via the returned handle. */
function harness(over: { enabled?: boolean; remote?: (id: string) => boolean } = {}) {
  const calls = { start: 0, stop: 0 }
  const state = { enabled: over.enabled ?? true }
  const opts: KeepAwakeOpts = {
    blocker: {
      start: () => void calls.start++,
      stop: () => void calls.stop++
    },
    enabled: () => state.enabled,
    isRemoteNode: over.remote ?? (() => false),
    log: () => {}
  }
  return { tracker: createKeepAwake(opts), calls, state }
}

const edge = (nodeId: string, event: KeepAwakeEdge['event'], state: string): KeepAwakeEdge => ({
  nodeId,
  event,
  state
})

describe('keep-awake tracker', () => {
  it('holds on the first local working edge, and only once across several working nodes', () => {
    const { tracker, calls } = harness()
    tracker.onChange(edge('a', 'start', 'working'))
    expect(calls.start).toBe(1)
    expect(tracker.holding()).toBe(true)
    // A second working node (and a repeat edge for the first) must not start a second assertion.
    tracker.onChange(edge('b', 'start', 'working'))
    tracker.onChange(edge('a', 'update', 'working'))
    expect(calls.start).toBe(1)
    expect(calls.stop).toBe(0)
  })

  it('releases when the LAST local node ends — not before', () => {
    const { tracker, calls } = harness()
    tracker.onChange(edge('a', 'start', 'working'))
    tracker.onChange(edge('b', 'start', 'working'))
    tracker.onChange(edge('a', 'end', 'done'))
    expect(calls.stop).toBe(0) // b still working
    tracker.onChange(edge('b', 'end', 'done'))
    expect(calls.stop).toBe(1)
    expect(tracker.holding()).toBe(false)
  })

  it('a needsYou edge releases just like an end — waiting on the human is not work', () => {
    const { tracker, calls } = harness()
    tracker.onChange(edge('a', 'start', 'working'))
    // The mirror sends needsYou as event 'update' with state 'needsYou' — event alone must not
    // keep the node in the working set.
    tracker.onChange(edge('a', 'update', 'needsYou'))
    expect(calls.stop).toBe(1)
    expect(tracker.holding()).toBe(false)
    // Answering resumes work: the next working edge holds again.
    tracker.onChange(edge('a', 'start', 'working'))
    expect(calls.start).toBe(2)
  })

  it('remote (SSH-homed) nodes never hold', () => {
    const { tracker, calls } = harness({ remote: (id) => id.startsWith('ssh-') })
    tracker.onChange(edge('ssh-x', 'start', 'working'))
    tracker.onChange(edge('ssh-x', 'update', 'working'))
    expect(calls.start).toBe(0)
    expect(tracker.holding()).toBe(false)
    // A local node alongside still holds; the remote node's end does not release it.
    tracker.onChange(edge('local-y', 'start', 'working'))
    expect(calls.start).toBe(1)
    tracker.onChange(edge('ssh-x', 'end', 'done'))
    expect(calls.stop).toBe(0)
  })

  it('disabled: edges never hold; enabling + refresh() mid-run holds without a new edge', () => {
    const { tracker, calls, state } = harness({ enabled: false })
    tracker.onChange(edge('a', 'start', 'working'))
    expect(calls.start).toBe(0)
    // The working set kept folding while disabled — the live toggle takes effect immediately.
    state.enabled = true
    tracker.refresh()
    expect(calls.start).toBe(1)
    expect(tracker.holding()).toBe(true)
    // And back: disabling releases while the node is still working.
    state.enabled = false
    tracker.refresh()
    expect(calls.stop).toBe(1)
    expect(tracker.holding()).toBe(false)
    // Re-enabling again re-holds from the still-folded set.
    state.enabled = true
    tracker.refresh()
    expect(calls.start).toBe(2)
  })

  it('end for an unknown node / double-end never calls stop() when not holding (no underflow)', () => {
    const { tracker, calls } = harness()
    tracker.onChange(edge('ghost', 'end', 'done'))
    expect(calls.stop).toBe(0)
    tracker.onChange(edge('a', 'start', 'working'))
    tracker.onChange(edge('a', 'end', 'done'))
    tracker.onChange(edge('a', 'end', 'done')) // duplicate end (e.g. natural end + ackDone re-send)
    expect(calls.stop).toBe(1)
    // The duplicate must not have poisoned the count: a new working node holds again.
    tracker.onChange(edge('b', 'start', 'working'))
    expect(calls.start).toBe(2)
  })

  it('dispose() while holding stops exactly once; while not holding, not at all', () => {
    const { tracker, calls } = harness()
    tracker.onChange(edge('a', 'start', 'working'))
    tracker.dispose()
    expect(calls.stop).toBe(1)
    expect(tracker.holding()).toBe(false)
    tracker.dispose()
    expect(calls.stop).toBe(1)
  })

  it('the stale sweep synthetic end releases — the leak backstop story', () => {
    const { tracker, calls } = harness()
    tracker.onChange(edge('a', 'start', 'working'))
    // sweepStaleWorking (agent-status-mirror) fires exactly this shape for a node silent past
    // WORKING_STALE_MS: event 'end', state 'done' (plus stale:true, which the tracker ignores).
    tracker.onChange({ ...edge('a', 'end', 'done'), stale: true } as KeepAwakeEdge)
    expect(calls.stop).toBe(1)
    expect(tracker.holding()).toBe(false)
  })

  it('sync() converges to the mirror set — the SessionStart silent-reset story', () => {
    // A SessionStart mid-working resets the mirror entry to idle WITHOUT an edge (upstream keeps
    // it silent to protect the new turn's Live Activity), which also disarms the stale sweep.
    // The flush-time sync is what releases the assertion then (the reset schedules the flush).
    const { tracker, calls } = harness({ remote: (id) => id.startsWith('remote-') })
    tracker.onChange(edge('a', 'start', 'working'))
    expect(tracker.holding()).toBe(true)
    tracker.sync([]) // the mirror no longer believes anything is working
    expect(calls.stop).toBe(1)
    expect(tracker.holding()).toBe(false)
    // And the inverse: a restored-at-boot working entry seeds a hold with the same gates.
    tracker.sync(['b', 'remote-1'])
    expect(calls.start).toBe(2)
    expect(tracker.holding()).toBe(true)
    // The remote id was filtered: releasing 'b' alone must release the assertion.
    tracker.onChange(edge('b', 'end', 'done'))
    expect(calls.stop).toBe(2)
    expect(tracker.holding()).toBe(false)
  })
})
