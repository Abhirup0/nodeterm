// Canvas sync — the ordering state. This is what makes two people editing the SAME node converge.
//
// THE PROBLEM. Stage 3's first cut was pure optimistic last-write-wins with no order: each client
// applied its own edit immediately, cast it, and applied whatever arrived from a peer. That is only
// safe if two edits are never in flight at once — and on a real (asynchronous) bus, two people
// dragging one node cross on EVERY frame:
//
//   A drags n1 to x=200 ─┐                    ┌─ B drags n1 to x=100
//                        ├─ both in flight ───┤
//   A applies B's 100 ───┘                    └─ B applies A's 200
//   → A shows 100, B shows 200. FOREVER. And both publishers have `adopt`ed, so neither
//     re-publishes — the divergence is permanent, and the next whole-file workspace.save from
//     either side overwrites the other's canvas on disk. Worse with a delete: A deletes a node,
//     B (mid-drag) sends the next frame, A applies it and RESURRECTS the node it just deleted —
//     the exact "a client writes back a node someone else deleted" bug Stage 3 exists to kill.
//
// THE FIX (no CRDT). The reflector stamps every mutation with a monotone `seq` — one total order,
// the same for everyone — and echoes it to EVERY client, the sender included. Per node, the highest
// `seq` wins. Two rules, and they are the whole algorithm:
//
//   1. OUR OWN ECHO IS AN ACK, NOT AN EDIT. We already applied it optimistically; re-applying it
//      would rubber-band a node we are still dragging (the echo carries the position from ~50 ms
//      ago). So we consume it for its `seq` and drop it.
//   2. WHILE ONE OF OUR OWN MUTATIONS FOR A NODE IS UNACKED, WE IGNORE PEERS' MUTATIONS FOR THAT
//      NODE. Not a heuristic — a consequence of FIFO delivery, which IPC and WebSocket both
//      guarantee: if the reflector had ordered our mutation BEFORE the peer's, our ack would
//      already have arrived (the reflector sent it to us first). So an unacked local mutation is
//      necessarily LATER in the total order than anything we are hearing now — it will win on every
//      other client, and keeping it here is what agrees with them.
//
// Together those give: every client ends on the mutation with the highest `seq` for that node.
// Convergence, on any interleaving. What it deliberately does NOT give is intent preservation —
// two people dragging one node still fight, and a delete concurrent with an edit is decided by the
// total order, not by "delete wins" (see docs/team-presence.md, which states the resolution).
//
// Pure: no React, no DOM, no timers (the pending TTL below is a lazy clock read, not a timer).

import type { CanvasMutation } from './types'

/**
 * How long an unacked local mutation keeps suppressing peers' mutations for that node.
 *
 * Rule 2 above assumes the ack ALWAYS comes back. Almost always it does — but the reflector drops
 * a mutation it cannot validate (an oversized sticky body: MUTATION_MAX_BYTES) and a cast made with
 * no project active never reaches it at all. Without a bound, one such drop would silently deafen
 * that node to its peers for the rest of the session. So a pending entry expires: after this long,
 * the node listens again. Generous next to a round trip (sub-millisecond in-process, single-digit
 * ms over a LAN WS) and short next to a human noticing.
 */
export const PENDING_TTL_MS = 5000

/** The node a mutation addresses. */
export function mutationNodeId(m: CanvasMutation): string {
  return m.op === 'remove' ? m.id : m.node.id
}

export interface CanvasOrder {
  /** Record a mutation WE are casting (it becomes pending until its echo comes back). */
  onLocal(m: CanvasMutation): void
  /**
   * Decide an incoming mutation (a peer's, or our own echoed back).
   * `true`  → apply it to the canvas.
   * `false` → drop it: our own echo (already applied), a straggler the total order has superseded,
   *           or a peer's edit to a node whose newer local edit of ours is still in flight.
   */
  accept(m: CanvasMutation): boolean
  /** Forget everything (project switch / disconnect). */
  reset(): void
}

interface Pending {
  count: number
  /** When the OLDEST still-unacked mutation for this node was cast (for PENDING_TTL_MS). */
  since: number
}

/**
 * Ordering state for one client. `src` is this client's publisher tag — the mutations it stamps,
 * and therefore the echoes it must recognize as its own.
 */
export function createCanvasOrder(
  src: string,
  opts: { now?: () => number; ttlMs?: number } = {}
): CanvasOrder {
  const now = opts.now ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? PENDING_TTL_MS
  /** Highest `seq` this client has SEEN for a node (applied or deliberately dropped). */
  const seen = new Map<string, number>()
  /** Our own casts for a node that have not been echoed back yet. */
  const pending = new Map<string, Pending>()

  const hasPending = (id: string): boolean => {
    const p = pending.get(id)
    if (!p) return false
    if (now() - p.since > ttlMs) {
      // The ack never came (the reflector refused the cast, or the project went away). Stop
      // suppressing this node's peers — a lost ack must not cost us the node forever.
      pending.delete(id)
      return false
    }
    return true
  }

  return {
    onLocal(m) {
      const id = mutationNodeId(m)
      const p = pending.get(id)
      if (p) p.count++
      else pending.set(id, { count: 1, since: now() })
    },

    accept(m) {
      const id = mutationNodeId(m)
      const seq = m.seq ?? 0
      const highest = seen.get(id) ?? 0
      if (seq > highest) seen.set(id, seq)

      if (m.src && m.src === src) {
        // Rule 1: our own mutation, echoed back. It is the ack — consume it, apply nothing.
        const p = pending.get(id)
        if (p && --p.count <= 0) pending.delete(id)
        return false
      }
      // A straggler: a mutation the total order has already superseded on this client (applied, or
      // deliberately dropped). Applying it would move the node BACKWARDS out of the total order.
      // `seq` 0 means an unstamped mutation (no reflector in the path) — never treat it as stale.
      if (seq !== 0 && seq <= highest) return false
      // Rule 2: an edit of ours for this node is still in flight, so it is later in the total order
      // than this one and will win everywhere. Keep ours; the peers will land on it.
      if (hasPending(id)) return false
      return true
    },

    reset() {
      seen.clear()
      pending.clear()
    }
  }
}
