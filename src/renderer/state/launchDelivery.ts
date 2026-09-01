import { create } from 'zustand'
import type { LaunchDelivery } from '../lib/pendingLaunch'

/**
 * What happened to an ARMED node's held launch (canvas-control `--after`, or the cold-open arming
 * a `--project` open leaves behind) — the visible half of the delivery loop that Canvas runs.
 *
 * TRANSIENT on purpose, like the live half of `agentStatus`. A delivery outcome describes THIS
 * app run's attempt to start a session: it is not a property of the canvas, it must not ride
 * `.nodeterm/project.json` to a teammate's machine, and a restart legitimately retries from
 * scratch. Nothing here is persisted.
 *
 * Absent = nothing to report: the node is simply waiting on its dependencies (which the QUEUED
 * badge already explains), or it has not been armed at all.
 *
 * The states, and why both exist:
 *  - `stalled` — the gate is OPEN (every dependency is satisfied) but the node's terminal has not
 *    come up, so there is nothing to deliver INTO yet. We keep waiting — an SSH host that comes
 *    back, a slow spawn and a project the user just switched to all end here first — but we say
 *    so, because "queued, indefinitely, with no reason given" is the exact complaint this whole
 *    change answers (#569 item 1).
 *  - `failed` — the terminal DID come up and refused the launch anyway, for every attempt in the
 *    backoff schedule. That is a real dead end: nothing further will retry it, so the badge must
 *    carry the warning and point at the manual ▶.
 *
 * Neither state is ever inferred from silence. `stalled` is raised by a timer that starts when
 * the gate opens, `failed` only after a delivery was actually attempted and refused.
 */
export type { LaunchDelivery }

interface LaunchDeliveryStore {
  byId: Record<string, LaunchDelivery | undefined>
  /** The gate opened but the node's session is not up yet — still waiting, and saying so. */
  markStalled: (nodeId: string) => void
  /** Every attempt in the schedule was refused. Terminal: only ▶ (or a respawn) revives it. */
  markFailed: (nodeId: string, attempts: number) => void
  /** Delivered, disarmed, or the node is gone — nothing left to report. */
  clear: (nodeId: string) => void
}

export const useLaunchDelivery = create<LaunchDeliveryStore>((set) => ({
  byId: {},
  markStalled: (nodeId) =>
    set((s) =>
      // Idempotent: the sweep can re-raise this on every re-render, and a fresh `since` on each
      // would make the badge's age tick backwards. `failed` is never downgraded to `stalled`.
      s.byId[nodeId] ? s : { byId: { ...s.byId, [nodeId]: { kind: 'stalled', since: Date.now() } } }
    ),
  markFailed: (nodeId, attempts) =>
    set((s) => {
      // Never let a later, smaller count shrink the record: the manual ▶ reports its own single
      // refusal, and it must not rewrite "5 attempts were refused" as "1 was".
      const prev = s.byId[nodeId]
      const total = Math.max(attempts, prev?.kind === 'failed' ? prev.attempts : 0)
      return { byId: { ...s.byId, [nodeId]: { kind: 'failed', attempts: total, at: Date.now() } } }
    }),
  clear: (nodeId) =>
    set((s) => {
      if (!s.byId[nodeId]) return s
      const { [nodeId]: _gone, ...rest } = s.byId
      return { byId: rest }
    })
}))
