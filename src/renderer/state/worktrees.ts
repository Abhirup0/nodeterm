import { create } from 'zustand'
import {
  normWorktreePath,
  reconcileWorktrees,
  type BoundGroup
} from '@shared/worktree-reconcile'
import type { WorktreeEntry } from '@shared/worktree'

/** What the group chip shows. `dirty` = staged + unstaged files. */
export interface WorktreeStatus {
  branch: string
  dirty: number
  ahead: number
  behind: number
}

/** The chip re-renders constantly; without this, every render would spawn a `git status`. */
export const WORKTREE_STATUS_THROTTLE_MS = 4000

interface WorktreesState {
  repoRoot: string | null
  entries: WorktreeEntry[]
  orphans: WorktreeEntry[]
  staleGroupIds: string[]
  statusByPath: Record<string, WorktreeStatus>
  refresh(projectCwd: string, bound: BoundGroup[]): Promise<void>
  /**
   * Poll one bound worktree's status. Pass the bound group's id to also keep its staleness LIVE:
   * `refresh()` only runs on project load / mutation, so without this a worktree deleted while the
   * user watches would keep a healthy-looking chip (and a restored one would keep saying "missing")
   * until a reload. `hasRepo === false` = the directory is gone → mark the group stale; a repo
   * answering again un-marks it.
   */
  refreshStatus(path: string, groupId?: string): Promise<void>
  reset(): void
}

const lastStatusAt = new Map<string, number>()

/**
 * Cancellation token for the in-flight async reads. `refresh`/`refreshStatus` are fired from React
 * effects and have no abort; a project switch calls `reset()` and starts the NEW project's refresh,
 * so the OLD project's call can still resolve afterwards and win the last write — leaving project B
 * holding project A's `repoRoot` and orphan list. Since worktrees are CREATED under `repoRoot` and
 * orphans are offered for DELETION, that stale write is not cosmetic. Every `set` is therefore
 * gated on the epoch the call started in.
 */
let epoch = 0

/** "No worktree facts" — what a non-repo project, a failed read and a reset all collapse to. */
const empty = (): Pick<WorktreesState, 'repoRoot' | 'entries' | 'orphans' | 'staleGroupIds'> => ({
  repoRoot: null,
  entries: [],
  orphans: [],
  staleGroupIds: []
})

export const useWorktrees = create<WorktreesState>((set) => ({
  repoRoot: null,
  entries: [],
  orphans: [],
  staleGroupIds: [],
  statusByPath: {},

  async refresh(projectCwd, bound) {
    // Bump the epoch at the START, before any await. This ensures a newer refresh always
    // supersedes an older one: if two refreshes are called in quick succession without an
    // intervening reset(), the second one bumps the epoch, making the first's epoch stale.
    // After bumping, capture the new epoch so this refresh knows if it was superseded.
    epoch++
    const mineEpoch = epoch
    const git = window.nodeTerminal.git
    try {
      const root = await git.repoRoot(projectCwd)
      if (mineEpoch !== epoch) return
      if (!root) {
        set(empty())
        return
      }
      // `entries` stays in git's order — reconcileWorktrees identifies the main checkout positionally.
      const entries = await git.worktreeList(root)
      if (mineEpoch !== epoch) return
      // Reconcile only the groups bound to THIS repo. A group bound to another repo's worktree
      // (legacy binding, or hand-typed) would otherwise be compared against the wrong entry list
      // and falsely reported stale.
      const mine = bound.filter(
        (b) => normWorktreePath(b.worktree.repoPath) === normWorktreePath(root)
      )
      const { stale, orphans } = reconcileWorktrees(mine, entries)
      set({ repoRoot: root, entries, orphans, staleGroupIds: stale })
    } catch {
      // Fail open: the IPC rejects on a transport error (WS-RPC, Server Edition) and callers are
      // fire-and-forget effects, so throwing here would only become an unhandled rejection. An
      // empty store means "no worktree facts" — every consumer already degrades to that.
      if (mineEpoch !== epoch) return
      set(empty())
    }
  },

  async refreshStatus(path, groupId) {
    const mineEpoch = epoch
    const now = Date.now()
    const prev = lastStatusAt.get(path) ?? 0
    if (now - prev < WORKTREE_STATUS_THROTTLE_MS) return
    lastStatusAt.set(path, now)
    let status: Awaited<ReturnType<typeof window.nodeTerminal.git.status>>
    try {
      status = await window.nodeTerminal.git.status(path)
    } catch {
      // Un-stamp, or a transient failure would lock the chip out of retrying for the whole window.
      if (lastStatusAt.get(path) === now) lastStatusAt.delete(path)
      return
    }
    if (mineEpoch !== epoch) return
    // A deleted worktree does NOT reject: git-service answers with an empty status. Writing it
    // would render a dead worktree as a healthy one on a blank branch — `staleGroupIds` is what
    // tells that story, so mark the group stale instead of keeping a lie on screen.
    if (!status.hasRepo) {
      if (groupId) {
        set((s) =>
          s.staleGroupIds.includes(groupId)
            ? s
            : { staleGroupIds: [...s.staleGroupIds, groupId] }
        )
      }
      return
    }
    set((s) => ({
      // The directory answers again (restored, or a transient read failure passed) → not stale.
      staleGroupIds:
        groupId && s.staleGroupIds.includes(groupId)
          ? s.staleGroupIds.filter((g) => g !== groupId)
          : s.staleGroupIds,
      statusByPath: {
        ...s.statusByPath,
        [path]: {
          branch: status.branch,
          dirty: status.staged.length + status.changes.length,
          ahead: status.ahead,
          behind: status.behind
        }
      }
    }))
  },

  reset() {
    epoch++
    lastStatusAt.clear()
    set({ ...empty(), statusByPath: {} })
  }
}))
