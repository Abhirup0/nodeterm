import { useEffect } from 'react'
import { create } from 'zustand'
import {
  addPending as addPendingCore,
  clearSeats,
  markConnected as markConnectedCore,
  markPending as markPendingCore,
  removeSeat,
  type SeatsState
} from './teamAccessCore'

/**
 * Transient Team Access seat table for the LOCAL host (docs/superpowers/plans/2026-07-15-team-access.md,
 * Task 3). Hosting is always done from this machine's own core, so — unlike presence/agentStatus —
 * there is no per-core session machinery here: one module-level store is correct.
 *
 * Fed by the relay-host events (Task 2): `relay:host:peer-pending` → `markPending`,
 * `relay:host:open` → `markConnected`, `relay:host:closed` → `remove`, host stop → `clear`. Task 4's
 * settings section additionally calls `addPending(id, email)` the instant `relayHost.invite()`
 * resolves, so the pending row shows before the peer connects.
 *
 * PRESENCE JOIN DEFERRED (v1): a seat is keyed by its renderer UUID (`id`), while a presence peer is
 * keyed by a ClientId — the two id spaces are not trivially joinable, so a seat row shows the invite
 * `email` label + a generic connected/pending state, NOT the peer's presence name/color. Wiring the
 * name/color join is a documented follow-up (it needs a seat-id ⇄ ClientId correlation the relay
 * layer does not currently carry). See the plan's Task 3 note.
 */
export interface TeamAccessStore {
  seats: SeatsState
  /** A seat minted by `relayHost.invite()` (reserved before the peer connects). */
  addPending(id: string, email?: string): void
  /** Ensure/enrich from a `relay:host:peer-pending` event (may beat or follow `addPending`). */
  markPending(id: string, email?: string): void
  /** A `relay:host:open` event — flip the known seat to connected. */
  markConnected(id: string): void
  /** A `relay:host:closed` event, or a manual revoke — drop the seat. */
  remove(id: string): void
  /** Host stop — empty the table. */
  clear(): void
}

export const useTeamAccess = create<TeamAccessStore>((set) => ({
  seats: {},
  addPending: (id, email) => set((s) => ({ seats: addPendingCore(s.seats, id, email) })),
  markPending: (id, email) => set((s) => ({ seats: markPendingCore(s.seats, id, email) })),
  markConnected: (id) => set((s) => ({ seats: markConnectedCore(s.seats, id) })),
  remove: (id) => set((s) => ({ seats: removeSeat(s.seats, id) })),
  clear: () => set({ seats: clearSeats() })
}))

/**
 * Subscribe the seat store to the relay-host events. Mounted ONCE (from Canvas), this is a SEPARATE
 * subscription set from Canvas's existing `relayHost.onPeerPending` (which drives the SAS approval
 * dialog) — both may observe `peer-pending`, and that is fine: one feeds the dialog, one feeds this
 * store. Do not fold them together. Cleaned up on unmount.
 */
export function useTeamAccessEvents(): void {
  const store = useTeamAccess
  useEffect(() => {
    const { markPending, markConnected, remove } = store.getState()
    const unPending = window.nodeTerminal.relayHost.onPeerPending((e) => markPending(e.id, e.email))
    const unOpen = window.nodeTerminal.relayHost.onOpen((e) => markConnected(e.id))
    const unClosed = window.nodeTerminal.relayHost.onClosed((e) => remove(e.id))
    return () => {
      unPending()
      unOpen()
      unClosed()
    }
  }, [store])
}
