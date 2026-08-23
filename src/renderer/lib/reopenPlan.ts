import type { ReopenEntry } from '@renderer/state/reopenHistory'
import type { ReopenNodeSnapshot } from './reopenNode'
import type { CanvasNode } from '@renderer/state/workspace'

/** What `app.reopenLastClosed` (Cmd+Shift+T) should do for ONE popped history entry. Pure
 *  decision only — no store writes, no `setNodes`, no navigation. `Canvas.tsx` executes
 *  whichever variant comes back; `'skip'` means the entry was stale (already reopened another
 *  way, its project was permanently deleted, or every node it held recreated to nothing) and the
 *  caller should keep popping. */
export type ReopenPlan =
  | { action: 'reopenProject'; projectId: string }
  | { action: 'insertActive'; nodes: CanvasNode[] }
  | { action: 'insertStored'; projectId: string; reopenProjectAfter: boolean; nodes: CanvasNode[] }
  | { action: 'skip' }

/** The subset of `Project` this decision needs — kept minimal so tests can pass plain fixtures
 *  instead of a full `Project`. */
export interface PlanReopenProject {
  id: string
  closed?: boolean
  nodes: readonly { id: string }[]
}

/**
 * Decides what reopening `entry` should do, given the CURRENT project list and active project —
 * both may have changed since the entry was recorded, which is exactly why an entry can be
 * stale. `activeLiveNodeIds` is the live React Flow node id set (`nodesRef.current` on the
 * canvas) — it's only consulted when `entry`'s project turns out to be the active one; a
 * non-active project's own `nodes` (its serialized snapshot) stands in otherwise, since there is
 * no live array for it. `recreate` is `recreateNodeFromSnapshot` pre-bound with everything except
 * the live-id set (account resolution, permission mode, the TARGET project) — kept as an
 * injected function so this stays pure and the account/permission-mode plumbing doesn't leak
 * into the decision logic under test.
 */
export function planReopen(
  entry: ReopenEntry,
  projects: readonly PlanReopenProject[],
  activeProjectId: string | undefined,
  activeLiveNodeIds: ReadonlySet<string>,
  recreate: (snapshot: ReopenNodeSnapshot, liveNodeIds: ReadonlySet<string>) => CanvasNode | null
): ReopenPlan {
  if (entry.kind === 'project') {
    const project = projects.find((p) => p.id === entry.projectId)
    // Only stale if it isn't sitting closed right now — already reopened another way, or gone.
    return project?.closed ? { action: 'reopenProject', projectId: entry.projectId } : { action: 'skip' }
  }

  const project = projects.find((p) => p.id === entry.projectId)
  if (!project) return { action: 'skip' } // permanently deleted since the entry was recorded

  const isActive = project.id === activeProjectId
  const liveIds = isActive ? activeLiveNodeIds : new Set(project.nodes.map((n) => n.id))
  const created = entry.nodes
    .map((snap) => recreate(snap, liveIds))
    .filter((n): n is CanvasNode => n !== null)
  // A snapshot that recreated to nothing (a kind this feature doesn't cover, or e.g. an editor
  // whose filePath is somehow missing) leaves the whole batch with nothing to insert — treat as
  // stale rather than switching/reopening a project for an empty result. A multi-node batch that
  // DID partially recreate still restores as ONE unit (whatever survived), never split across plans.
  if (!created.length) return { action: 'skip' }

  return isActive
    ? { action: 'insertActive', nodes: created }
    : {
        action: 'insertStored',
        projectId: project.id,
        reopenProjectAfter: !!project.closed,
        nodes: created
      }
}
