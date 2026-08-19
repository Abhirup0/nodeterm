import { create } from 'zustand'
import type { ProjectSetupEvent, ProjectSetupKind } from '@shared/project-settings'

/**
 * Renderer view of the setup/archive runs main is streaming (`ProjectSetupEvent` on
 * `IPC.projectSetupEvent(projectId)`). One entry per lane:
 *
 *  - `byProject` — a run the user started from the project's settings pane,
 *  - `byGroup`   — a run bound to a worktree group (Task 5 fills this from the worktree flow;
 *    the lane exists now so the shape does not change under it).
 *
 * The wire is the reason this store has any logic at all. `seq` is monotonic PER RUN precisely so
 * a client can tell a re-delivered event from a fresh one — over the relay a cast can arrive
 * twice, and out of order — so every event is measured against the last one applied and a
 * duplicate or stale one is DROPPED. Dropping is the safe direction: a lost chunk costs a few
 * bytes of visible output, whereas replaying one would duplicate output, and letting a stale
 * `running` land after a `done` would show a finished run as still going.
 */

/** How much of a run's output the panel keeps, in characters. A setup script's output is
 *  unbounded (an `npm install` alone is tens of KB) and this is a status box, not a terminal: the
 *  END is what matters, because that is where the failure is. */
export const SETUP_TAIL_MAX = 8 * 1024

export interface SetupRunState {
  runKey: string
  kind: ProjectSetupKind
  state: ProjectSetupEvent['state']
  /** Last `SETUP_TAIL_MAX` characters of the run's output. */
  tail: string
  exitCode?: number
  /** Highest `seq` applied for THIS `runKey` — the dedupe watermark. Lives on the entry (rather
   *  than a side map) so a new run resets it by construction; nothing to sweep. */
  seq: number
}

interface ProjectSetupState {
  byProject: Record<string, SetupRunState | undefined>
  byGroup: Record<string, SetupRunState | undefined>
  /** Fold one event into the lane it belongs to: `groupId` when the run is a worktree's, else the
   *  project's own lane. */
  applyEvent(projectId: string, ev: ProjectSetupEvent, groupId?: string): void
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

/**
 * The fold. Returns the next entry, or `null` when the event must be dropped.
 *
 * A DIFFERENT `runKey` always starts a fresh entry: the two runs' `seq` counters are unrelated, so
 * there is nothing to compare, and main refuses a second concurrent run for the same target
 * (`skipped: 'busy'`) — a live run's events cannot interleave with another's on the same lane.
 */
function foldEvent(prev: SetupRunState | undefined, ev: ProjectSetupEvent): SetupRunState | null {
  if (prev && prev.runKey === ev.runKey) {
    // Duplicate (re-delivered) or stale (overtaken): the watermark has already passed it.
    if (ev.seq <= prev.seq) return null
    return {
      runKey: prev.runKey,
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
  return {
    runKey: ev.runKey,
    kind: ev.kind,
    state: ev.state,
    tail: appendTail('', ev.chunk),
    ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
    seq: ev.seq
  }
}

export const useProjectSetup = create<ProjectSetupState>((set, get) => ({
  byProject: {},
  byGroup: {},

  applyEvent: (projectId, ev, groupId) => {
    if (groupId !== undefined) {
      const next = foldEvent(get().byGroup[groupId], ev)
      if (!next) return
      set((s) => ({ byGroup: { ...s.byGroup, [groupId]: next } }))
      return
    }
    const next = foldEvent(get().byProject[projectId], ev)
    if (!next) return
    set((s) => ({ byProject: { ...s.byProject, [projectId]: next } }))
  },

  subscribeProject: (projectId) =>
    window.nodeTerminal.projectSetup.onEvent(projectId, (ev) => {
      get().applyEvent(projectId, ev)
    })
}))
