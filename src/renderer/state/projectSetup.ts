import { create } from 'zustand'
import type { ProjectSetupEvent, ProjectSetupKind } from '@shared/project-settings'

/**
 * Renderer view of the setup/archive runs main is streaming (`ProjectSetupEvent` on
 * `IPC.projectSetupEvent(projectId)`).
 *
 * ONE STORAGE LANE, `byRunKey`, fed by the events themselves — because an event carries no
 * discriminator saying which UI raised the run. Routing by "whoever subscribed last" would put a
 * worktree's setup run in the settings panel and a panel run in the worktree card, at random. So
 * the initiator ATTACHES its run instead: whoever got the `started` ack (and therefore knows the
 * `runKey`) calls `attachProject` / `attachGroup`, and `runForProject` / `runForGroup` resolve
 * through those attachments. Events for a runKey nobody has attached are still recorded — the
 * attachment may land a tick later, and the head of the output must survive that.
 *
 * `byRunKey` does not grow without bound: `runKey` is DETERMINISTIC (kind + location), so the key
 * space is two entries per project location, and a re-run of the same script re-uses its slot.
 *
 * FOLDING, and why every field of it is load-bearing:
 *  - a different `runId` (unique per launch) always starts a FRESH entry, even under the same
 *    `runKey`. Two sequential runs of one script share the runKey and each restart `seq` at 1, so
 *    without this the second run's events would be dropped as stale and the finished run's exit
 *    badge would stand over a live script.
 *  - within one `runId`, `seq` is the dedupe watermark: `ev.seq <= prev.seq` is DROPPED. Over the
 *    relay a cast can arrive twice, and out of order. Dropping is the safe direction — replaying
 *    would double the output, and a stale `running` landing after a `done` would show a finished
 *    run as live.
 */

/** How much of a run's output the panel keeps, in characters. A setup script's output is
 *  unbounded (an `npm install` alone is tens of KB) and this is a status box, not a terminal: the
 *  END is what matters, because that is where the failure is. */
export const SETUP_TAIL_MAX = 8 * 1024

export interface SetupRunState {
  /** The deterministic single-flight key — what `cancel` takes. */
  runKey: string
  /** Unique per launch; what identity-of-run decisions fold on. */
  runId: string
  kind: ProjectSetupKind
  state: ProjectSetupEvent['state']
  /** Last `SETUP_TAIL_MAX` characters of the run's output. */
  tail: string
  exitCode?: number
  /** Highest `seq` applied for THIS `runId` — the dedupe watermark. Lives on the entry (rather
   *  than a side map) so a new run resets it by construction; nothing to sweep. */
  seq: number
}

interface ProjectSetupState {
  /** Every run seen on the wire, keyed by its single-flight key. */
  byRunKey: Record<string, SetupRunState | undefined>
  /** projectId -> the runKey its own launch claimed. */
  projectRunKey: Record<string, string | undefined>
  /** groupId -> the runKey that worktree's launch claimed (Task 5). */
  groupRunKey: Record<string, string | undefined>
  /** Fold one event into `byRunKey`. Takes no lane: the lanes come from the attachments. */
  applyEvent(ev: ProjectSetupEvent): void
  /** Called by the initiator with the runKey main acknowledged. */
  attachProject(projectId: string, runKey: string): void
  attachGroup(groupId: string, runKey: string): void
  runForProject(projectId: string): SetupRunState | undefined
  runForGroup(groupId: string): SetupRunState | undefined
  /** Wire this project's event channel into `applyEvent`; returns the unsubscribe. The preload api
   *  ref-counts subscribe/unsubscribe per project (boardLog.onChanged's shape), so several callers
   *  may hold one at once. */
  subscribeProject(projectId: string): () => void
}

/** Appends `chunk` and keeps only the last `SETUP_TAIL_MAX` characters. */
function appendTail(prev: string, chunk: string | undefined): string {
  if (!chunk) return prev
  const next = prev + chunk
  return next.length <= SETUP_TAIL_MAX ? next : next.slice(next.length - SETUP_TAIL_MAX)
}

/** The fold. Returns the next entry, or `null` when the event must be dropped. */
function foldEvent(prev: SetupRunState | undefined, ev: ProjectSetupEvent): SetupRunState | null {
  // Same LAUNCH: apply the watermark.
  if (prev && prev.runId === ev.runId) {
    // Duplicate (re-delivered) or stale (overtaken): the watermark has already passed it.
    if (ev.seq <= prev.seq) return null
    return {
      runKey: prev.runKey,
      runId: prev.runId,
      kind: ev.kind,
      state: ev.state,
      tail: appendTail(prev.tail, ev.chunk),
      // A terminal event carries the code; a later event never un-sets one already reported.
      ...(ev.exitCode !== undefined
        ? { exitCode: ev.exitCode }
        : prev.exitCode !== undefined
          ? { exitCode: prev.exitCode }
          : {}),
      seq: ev.seq
    }
  }
  // A different launch (or the first one): a fresh entry — nothing of the previous run carries
  // over, and its `seq` counter is unrelated to ours.
  return {
    runKey: ev.runKey,
    runId: ev.runId,
    kind: ev.kind,
    state: ev.state,
    tail: appendTail('', ev.chunk),
    ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
    seq: ev.seq
  }
}

export const useProjectSetup = create<ProjectSetupState>((set, get) => ({
  byRunKey: {},
  projectRunKey: {},
  groupRunKey: {},

  applyEvent: (ev) => {
    const next = foldEvent(get().byRunKey[ev.runKey], ev)
    if (!next) return
    set((s) => ({ byRunKey: { ...s.byRunKey, [ev.runKey]: next } }))
  },

  attachProject: (projectId, runKey) =>
    set((s) => ({ projectRunKey: { ...s.projectRunKey, [projectId]: runKey } })),

  attachGroup: (groupId, runKey) =>
    set((s) => ({ groupRunKey: { ...s.groupRunKey, [groupId]: runKey } })),

  runForProject: (projectId) => {
    const runKey = get().projectRunKey[projectId]
    return runKey === undefined ? undefined : get().byRunKey[runKey]
  },

  runForGroup: (groupId) => {
    const runKey = get().groupRunKey[groupId]
    return runKey === undefined ? undefined : get().byRunKey[runKey]
  },

  subscribeProject: (projectId) =>
    window.nodeTerminal.projectSetup.onEvent(projectId, (ev) => {
      get().applyEvent(ev)
    })
}))
