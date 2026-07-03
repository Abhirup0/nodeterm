// Pure helpers for the remote canvas mirror: turn a host's node snapshot into a
// wire-syncable form and apply mutations. No Electron, no sockets — shared by the
// host broadcast and the client mirror in later tasks.

import type { CanvasMutation, CanvasNodeState, CanvasState } from '@shared/types'

export type { CanvasMutation, CanvasState } from '@shared/types'

/**
 * Apply a single mutation to a node list, returning a NEW array (the input is never
 * mutated). `upsert` replaces the node with the matching id, or appends it if absent;
 * `remove` filters out the node with the given id.
 */
export function applyMutation(
  nodes: CanvasNodeState[],
  m: CanvasMutation
): CanvasNodeState[] {
  if (m.op === 'remove') {
    return nodes.filter((node) => node.id !== m.id)
  }
  // upsert
  const idx = nodes.findIndex((node) => node.id === m.node.id)
  if (idx === -1) {
    return [...nodes, m.node]
  }
  const next = nodes.slice()
  next[idx] = m.node
  return next
}

/**
 * R7 — sanitize a CLIENT-supplied mutation before the host applies it.
 *
 * A client may only (a) remove nodes and (b) update the layout/cosmetic fields of nodes the
 * host already has. Everything else stays host-authoritative, because upserted node state has
 * real authority on the host: a terminal node's `shell`/`cwd` feed the PTY spawn when the host
 * renderer mounts it (an approved client could otherwise spawn a shell in a cwd of its choice —
 * reopening the remote `pty.create` that R1 deliberately blocked), `cwd` also WIDENS the remote
 * fs jail (`rootsFromCanvas`), `ssh`/`sshRemoteTmux` retarget spawns at other hosts, and
 * `filePath`/`url` make the host open arbitrary files/pages. Brand-new node ids are rejected
 * outright — the client UI only ever moves/deletes existing nodes.
 *
 * Returns the safe mutation to apply, or null to drop it entirely.
 */
export function sanitizeClientMutation(
  m: CanvasMutation,
  current: CanvasState | null
): CanvasMutation | null {
  if (m.op === 'remove') return typeof m.id === 'string' && m.id ? m : null
  if (m.op !== 'upsert' || !m.node || typeof m.node !== 'object') return null
  const incoming = m.node
  const existing = current?.nodes.find((n) => n.id === incoming.id)
  if (!existing) return null // clients may not CREATE nodes
  // Light shape checks on the layout fields so a malformed payload can't wedge React Flow.
  const pos = incoming.position
  const size = incoming.size
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  const node: CanvasNodeState = {
    ...existing, // kind, shell, cwd, ssh, sshRemoteTmux, sshFs, agentId, filePath, url, worktree, …
    position: { x: pos.x, y: pos.y },
    size: { width: size.width, height: size.height },
    title: typeof incoming.title === 'string' ? incoming.title : existing.title,
    color: typeof incoming.color === 'string' ? incoming.color : existing.color,
    group: incoming.group ?? null,
    tags: incoming.tags,
    collapsed: incoming.collapsed,
    // Full-state semantics: an absent parentId means "ungrouped", so take it verbatim.
    parentId: incoming.parentId,
    text: typeof incoming.text === 'string' ? incoming.text : existing.text
  }
  return { op: 'upsert', node }
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
 * Diff two node snapshots into the minimal mutation list (deterministic): an `upsert`
 * for every node that was added or changed (deep-equal via stable stringify), and a
 * `remove` for every node that was dropped. Never throws on normal input.
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
    if (!nextIds.has(node.id)) {
      mutations.push({ op: 'remove', id: node.id })
    }
  }
  return mutations
}
