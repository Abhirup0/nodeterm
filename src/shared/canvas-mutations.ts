// The canvas mutation vocabulary — ONE implementation, imported by every surface:
// the relay host (src/main/remote), the renderer (Canvas), and the canvas-sync reflector
// (src/core). Pure: no electron, no sockets, no disk.

import type { CanvasMutation, CanvasNodeState } from './types'

/**
 * Apply a single mutation to a node list, returning a NEW array (the input is never mutated).
 * `upsert` replaces the node with the matching id, or appends it if absent; `remove` filters
 * out the node with the given id.
 */
export function applyCanvasMutation(
  states: CanvasNodeState[],
  m: CanvasMutation
): CanvasNodeState[] {
  if (m.op === 'remove') return states.filter((n) => n.id !== m.id)
  const idx = states.findIndex((n) => n.id === m.node.id)
  if (idx === -1) return [...states, m.node]
  const next = states.slice()
  next[idx] = m.node
  return next
}

/** Stable JSON stringify (keys sorted) so deep-equality is order-independent. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k]
      }
      return sorted
    }
    return val
  })
}

/**
 * Diff two node snapshots into the minimal mutation list (deterministic): an `upsert` for every
 * node that was added or changed (deep-equal via stable stringify), and a `remove` for every node
 * that was dropped. Never throws on normal input.
 */
export function diffToMutations(
  prev: CanvasNodeState[],
  next: CanvasNodeState[]
): CanvasMutation[] {
  const mutations: CanvasMutation[] = []
  const prevById = new Map(prev.map((node) => [node.id, node]))
  const nextIds = new Set(next.map((node) => node.id))

  // upserts: added or changed nodes (in next-array order for determinism).
  for (const node of next) {
    const before = prevById.get(node.id)
    if (!before || stableStringify(before) !== stableStringify(node)) {
      mutations.push({ op: 'upsert', node })
    }
  }
  // removes: nodes present in prev but gone from next (in prev-array order).
  for (const node of prev) {
    if (!nextIds.has(node.id)) mutations.push({ op: 'remove', id: node.id })
  }
  return mutations
}
