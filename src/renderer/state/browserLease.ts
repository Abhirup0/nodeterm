import { create } from 'zustand'
import { useEffect, useReducer } from 'react'
import {
  chipVisibleAt,
  INDICATOR_LINGER_MS,
  type BrowserLeaseEntry,
  type BrowserLeasePush
} from '@shared/browser-indicator'

/**
 * The renderer's view of which browser nodes an agent is DRIVING (S8 PR 6 of #112, @Corvin). Fed by
 * a `browser:lease-changed` push from main, which owns the debugger lease + the ownership ledger;
 * this store never decides ownership, it only paints what main verified. The chip, the rope
 * highlight and the Settings kill row all read it, so they can never disagree.
 *
 * The `browser` verb that MAKES a lease active lands in PR 7 — until then main pushes nothing with a
 * live `leaseActiveUntil`, so `entries` stays empty in practice while every path below is real and
 * tested. Stop, however, is live now: main pushes the stopped node in `stopped` and it drops here at
 * once.
 */
export type LeaseEntries = Record<string, BrowserLeaseEntry>

/**
 * Fold one push into the entry map. Two rules that must never merge:
 *  - `stopped` ids drop IMMEDIATELY, skipping the linger — the user (or a lifecycle event) ended
 *    control, so the chip must vanish now, not fade.
 *  - `active` ids upsert with their fresh window; a node that merely goes idle is NOT in `stopped`
 *    and keeps lingering {@link INDICATOR_LINGER_MS} past its `leaseActiveUntil` (the anti-flicker
 *    rule), then gets swept here once it is truly done.
 * Pure, so the flicker and the stop-is-immediate behaviours are unit-tested without the IPC.
 */
export function applyLeasePush(prev: LeaseEntries, push: BrowserLeasePush, now: number): LeaseEntries {
  const next: LeaseEntries = { ...prev }
  for (const id of push.stopped) delete next[id]
  for (const a of push.active) {
    next[a.browserNodeId] = { ownerNodeId: a.ownerNodeId, leaseActiveUntil: a.leaseActiveUntil }
  }
  // Sweep entries whose lease AND linger have both elapsed (a natural expiry, not a stop).
  for (const [id, e] of Object.entries(next)) if (!chipVisibleAt(e, now)) delete next[id]
  return next
}

interface BrowserLeaseState {
  entries: LeaseEntries
  /** Apply a push (also the test seam — components never call it). */
  apply: (push: BrowserLeasePush) => void
}

export const useBrowserLease = create<BrowserLeaseState>((set) => {
  const apply = (push: BrowserLeasePush): void =>
    set((s) => ({ entries: applyLeasePush(s.entries, push, Date.now()) }))
  // One subscription for the app's lifetime. Guarded so the store imports cleanly under jsdom /
  // Server Edition, where the bridge is absent.
  window.nodeTerminal?.browser?.onLeaseChanged?.(apply)
  return { entries: {}, apply }
})

/**
 * Is this node being driven RIGHT NOW (including the linger), and by whom? Returns the entry while
 * the chip should show, else null. Schedules a single re-render at the exact moment the linger
 * lapses, so the chip disappears on its own without a per-second poll.
 */
export function useDrivingLease(nodeId: string): BrowserLeaseEntry | null {
  const entry = useBrowserLease((s) => s.entries[nodeId])
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!entry) return
    const remaining = entry.leaseActiveUntil + INDICATOR_LINGER_MS - Date.now()
    if (remaining <= 0) return
    const t = setTimeout(bump, remaining + 20)
    return () => clearTimeout(t)
  }, [entry])
  if (!entry) return null
  return chipVisibleAt(entry, Date.now()) ? entry : null
}

/** The set of browser node ids currently being driven — the rope highlight (Task 6.2) and the
 *  Settings kill row read this. A node with no ledger-backed entry is never in it, so a hostile
 *  pre-declared rope is never highlighted. */
export function drivingNodeIds(entries: LeaseEntries, now: number): Set<string> {
  const ids = new Set<string>()
  for (const [id, e] of Object.entries(entries)) if (chipVisibleAt(e, now)) ids.add(id)
  return ids
}
