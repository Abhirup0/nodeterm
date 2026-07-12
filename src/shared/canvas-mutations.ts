// The canvas mutation vocabulary — ONE implementation, imported by every surface:
// the relay host (src/main/remote), the renderer (Canvas), and the canvas-sync reflector
// (src/core). Pure: no electron, no sockets, no disk.

import { REF_MAX_LEN } from './presence'
import type { CanvasMutation, CanvasNodeState } from './types'

/**
 * Ceiling on one mutation's serialized size. A node carries free text (a sticky's body, an
 * editor's path), and the whole object is reflected verbatim to every peer — so an unbounded one
 * is an N-way amplifier straight into everyone's WS send buffer (the same sink pty output rides).
 * 256 KB is orders of magnitude past any real node and cannot refuse a legitimate edit.
 */
export const MUTATION_MAX_BYTES = 256_000

/** An id off the wire: non-empty and bounded by the shared ref cap (node ids and project ids are
 *  short and generated — `term-ab12`, `project-1` — so this can never refuse a real one). Ids are
 *  REJECTED, never truncated: a truncated id would address the WRONG node on every peer. */
export function isRefId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= REF_MAX_LEN
}

/**
 * Shape + size guard: a client cast is untrusted input, and it is reflected to every peer as-is.
 * A malformed payload would wedge a peer's React Flow (applyCanvasMutation would upsert a node with
 * no id, or a NaN position, which React Flow cannot lay out); an oversized one would flood their
 * sockets.
 *
 * IT LIVES IN `shared`, NOT IN THE REFLECTOR, because BOTH ends need the same verdict. The reflector
 * drops what it refuses — silently, with no negative ack — so a publisher that cast it anyway would
 * advance its baseline (never retrying) and record a pending entry (deafening that node to its peers
 * for the whole pending TTL: a peer's `remove` landing in that window would be dropped, and the next
 * whole-file save would resurrect the node they deleted). The publisher therefore asks THIS function
 * first and, on a refusal, casts nothing, records nothing, and keeps the node in its baseline so the
 * next edit retries it. One predicate, one verdict, both ends.
 */
export function isCanvasMutation(value: unknown): value is CanvasMutation {
  if (!value || typeof value !== 'object') return false
  const m = value as { op?: unknown; id?: unknown; node?: unknown }
  if (m.op === 'remove') return isRefId(m.id)
  if (m.op !== 'upsert') return false
  const node = m.node as { id?: unknown; position?: { x?: unknown; y?: unknown } } | undefined
  if (!node || typeof node !== 'object') return false
  if (!isRefId(node.id)) return false
  const pos = node.position
  if (!pos || typeof pos !== 'object') return false
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false
  return withinSizeLimit(m)
}

function withinSizeLimit(m: unknown): boolean {
  try {
    // The wire form is JSON on the server and a structured clone on the desktop; either way this
    // is a faithful measure of what would be pushed to every peer. A value that cannot even be
    // stringified (BigInt, a cycle) is not something we should be reflecting.
    return JSON.stringify(m).length <= MUTATION_MAX_BYTES
  } catch {
    return false
  }
}

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
