/**
 * Pure reducer over the Team Access seat table (docs/superpowers/plans/2026-07-15-team-access.md,
 * Task 3). One entry per seat the local host has minted for a device — `pending` from the moment
 * `relayHost.invite()` returns its id (before the peer connects), `connected` once the peer opens.
 * Transient: nothing here is persisted; the host rebuilds the table from the relay-host events on
 * the next hosting session.
 *
 * COUNTER SEMANTICS — `usedCount` = pending + connected (i.e. the whole table). This is deliberate
 * and matches the Task-2 seat cap, which counts `byId.size` (every minted seat, reserved or live).
 * A pending invite RESERVES a seat, so the settings "Used X / N" must count it too — otherwise the
 * UI would show "Used 1/3" while the host is refused a 3rd invite because two are pending-reserved.
 * `connectedCount` is exposed separately for anywhere that wants only the live devices.
 */
export interface SeatEntry {
  id: string
  /** The invitee email this seat was invited with (DISPLAY label only — the SAS is the trust gate). */
  email?: string
  status: 'pending' | 'connected'
}

export type SeatsState = Record<string, SeatEntry>

/** Add a freshly-minted (reserved) seat — called when `relayHost.invite()` resolves, before the
 *  peer connects. Idempotent: a repeat add for an existing id enriches its email (fills a missing
 *  one) and keeps its current status, so it never downgrades a seat that has already connected. */
export function addPending(seats: SeatsState, id: string, email?: string): SeatsState {
  const prev = seats[id]
  if (prev) {
    return { ...seats, [id]: { ...prev, email: email ?? prev.email } }
  }
  return { ...seats, [id]: { id, email, status: 'pending' } }
}

/** Ensure/enrich a seat from a `relay:host:peer-pending` event (may beat OR follow the invite-return
 *  add). Adds the seat as `pending` if unseen; otherwise enriches its email and leaves its status
 *  alone — so a seat already `connected` is never downgraded by a late/duplicate pending event. */
export function markPending(seats: SeatsState, id: string, email?: string): SeatsState {
  return addPending(seats, id, email)
}

/** Flip a KNOWN seat to `connected` (a `relay:host:open` event). No-op on an unknown id: a seat
 *  always exists from mint (`addPending`), so an open for an id we never minted is ignored rather
 *  than fabricating a seat with no invite context. */
export function markConnected(seats: SeatsState, id: string): SeatsState {
  const prev = seats[id]
  if (!prev) return seats
  if (prev.status === 'connected') return seats
  return { ...seats, [id]: { ...prev, status: 'connected' } }
}

/** Drop a seat (a `relay:host:closed` event, or a manual revoke). */
export function removeSeat(seats: SeatsState, id: string): SeatsState {
  if (!(id in seats)) return seats
  const next = { ...seats }
  delete next[id]
  return next
}

/** Empty the table (host stop). */
export function clearSeats(): SeatsState {
  return {}
}

/** Seats consuming a licensed seat = pending (reserved) + connected — see COUNTER SEMANTICS above. */
export function usedCount(seats: SeatsState): number {
  return Object.keys(seats).length
}

/** Live devices only. */
export function connectedCount(seats: SeatsState): number {
  return Object.values(seats).filter((s) => s.status === 'connected').length
}

/** Reserved-but-not-yet-connected seats. */
export function pendingCount(seats: SeatsState): number {
  return Object.values(seats).filter((s) => s.status === 'pending').length
}

/** The seats as an array in insertion (mint) order. */
export function listSeats(seats: SeatsState): SeatEntry[] {
  return Object.values(seats)
}
