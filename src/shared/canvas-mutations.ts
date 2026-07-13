// The canvas mutation vocabulary — ONE implementation, imported by every surface:
// the relay host (src/main/remote), the renderer (Canvas), and the canvas-sync reflector
// (src/core). Pure: no electron, no sockets, no disk.

import { carryLocalNodeExec, sanitizeInboundNode } from './node-exec'
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
 * Same top-level VALUE? A shallow compare, deliberately: it never reads the CONTENT of a string
 * field, which is the whole point (the free text is what makes an oversized node expensive).
 *
 * Sound because of how the snapshot is built: `flowToNodeStates` rebuilds the node object on every
 * publish but passes each field through BY REFERENCE (`text: n.data.text`, `tags: n.data.tags`, …),
 * so an untouched field is the SAME reference and `Object.is` settles it in O(1). `position` and
 * `size` are freshly built objects of numbers, so they are compared field-wise.
 *
 * Conservative in the only direction that matters: equal references ⇒ equal content, so it can never
 * report "unchanged" for a node that changed (which would strand an edit). The reverse (an equal
 * value rebuilt as a new reference) merely costs one honest re-validation — what happens today.
 */
function sameNodeValue(a: CanvasNodeState, b: CanvasNodeState): boolean {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  for (const k of ka) {
    const va = ra[k]
    const vb = rb[k]
    if (Object.is(va, vb)) continue
    if (k !== 'position' && k !== 'size') return false
    // The two geometry objects: plain records of numbers, rebuilt on every snapshot.
    const oa = va as Record<string, number> | undefined
    const ob = vb as Record<string, number> | undefined
    if (!oa || !ob) return false
    const gk = Object.keys(oa)
    if (gk.length !== Object.keys(ob).length) return false
    for (const g of gk) if (!Object.is(oa[g], ob[g])) return false
  }
  return true
}

/**
 * The PUBLISHER's guard: `isCanvasMutation`'s verdict, with a refusal REMEMBERED per node.
 *
 * `isCanvasMutation` answers the size question by serializing the whole node, and a refused node is
 * deliberately re-emitted on every publish (that is what makes the sticky sync the instant the user
 * trims it — see `rebaseRefused` in canvas-publish). A drag publishes at ~20 Hz. So the ONE node that
 * is already pathological — a sticky someone pasted a document into — was being stringified 20 times
 * a second, at a cost proportional to its size, for as long as it stayed oversized. The pathological
 * case must not also be the expensive one.
 *
 * The memo holds the refused node itself and re-checks only when that node's value actually changes
 * (`sameNodeValue`: reference-shallow, so it never touches the big string). Behaviour is unchanged:
 * the same verdict for every input, the refusal is re-paid the moment the node is edited, and the
 * trimmed sticky casts immediately (its entry is dropped as soon as it passes). Bounded by the number
 * of oversized nodes on the canvas — in practice zero or one, and their memory is the node the canvas
 * already holds.
 *
 * The REFLECTOR keeps calling the plain `isCanvasMutation`: its input is untrusted, freshly decoded
 * off the wire for every client, so nothing there would ever hit a memo and the map would grow with
 * whatever ids a client cared to invent. One predicate, one verdict, both ends — this only caches the
 * one end that asks the same question about the same node over and over.
 */
export function createMutationGuard(): (m: CanvasMutation) => boolean {
  const refused = new Map<string, CanvasNodeState>()
  return (m) => {
    // A `remove` is a couple of dozen bytes: nothing to amortize, and nothing that can grow.
    if (!m || typeof m !== 'object' || (m as { op?: unknown }).op !== 'upsert')
      return isCanvasMutation(m)
    const node = (m as { node?: CanvasNodeState }).node
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') return isCanvasMutation(m)

    const last = refused.get(node.id)
    if (last && sameNodeValue(last, node)) return false // already refused, and nothing has changed

    const ok = isCanvasMutation(m)
    if (ok) refused.delete(node.id)
    else refused.set(node.id, node)
    return ok
  }
}

/**
 * Apply a single mutation to a node list, returning a NEW array (the input is never mutated).
 * `upsert` replaces the node with the matching id, or appends it if absent; `remove` filters
 * out the node with the given id.
 *
 * Every caller of this is applying a mutation that came from SOMEONE ELSE (a canvas-sync peer, a
 * relay client), so the node goes through `sanitizeInboundNode` first: the exec-enabling fields
 * (`shell`, `ssh.extraArgs`) are per-machine settings that nobody else gets to write, and letting
 * them into the live node array is how a peer laundered them into the machine-local — "trusted" —
 * workspace.json on the next save (@shared/node-exec).
 */
export function applyCanvasMutation(
  states: CanvasNodeState[],
  m: CanvasMutation
): CanvasNodeState[] {
  if (m.op === 'remove') return states.filter((n) => n.id !== m.id)
  const node = sanitizeInboundNode(m.node)
  const idx = states.findIndex((n) => n.id === node.id)
  if (idx === -1) return [...states, node]
  const next = states.slice()
  // …and OUR exec fields stay on the node the upsert replaces: they are per-machine, so a peer
  // dragging our ssh terminal must not hand it back stripped of the jump host we configured.
  next[idx] = carryLocalNodeExec(states[idx], node)
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
