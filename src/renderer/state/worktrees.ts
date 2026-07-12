import { create } from 'zustand'
import { reconcileWorktrees, type BoundGroup } from '@shared/worktree-reconcile'
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
  refreshStatus(path: string): Promise<void>
  reset(): void
}

const lastStatusAt = new Map<string, number>()

const normPath = (p: string): string => p.trim().replace(/\/+$/, '')

export const useWorktrees = create<WorktreesState>((set) => ({
  repoRoot: null,
  entries: [],
  orphans: [],
  staleGroupIds: [],
  statusByPath: {},

  async refresh(projectCwd, bound) {
    const git = window.nodeTerminal.git
    const root = await git.repoRoot(projectCwd)
    if (!root) {
      set({ repoRoot: null, entries: [], orphans: [], staleGroupIds: [] })
      return
    }
    // `entries` stays in git's order — reconcileWorktrees identifies the main checkout positionally.
    const entries = await git.worktreeList(root)
    // Reconcile only the groups bound to THIS repo. A group bound to another repo's worktree
    // (legacy binding, or hand-typed) would otherwise be compared against the wrong entry list
    // and falsely reported stale.
    const mine = bound.filter((b) => normPath(b.worktree.repoPath) === normPath(root))
    const { stale, orphans } = reconcileWorktrees(mine, entries)
    set({ repoRoot: root, entries, orphans, staleGroupIds: stale })
  },

  async refreshStatus(path) {
    const now = Date.now()
    const prev = lastStatusAt.get(path) ?? 0
    if (now - prev < WORKTREE_STATUS_THROTTLE_MS) return
    lastStatusAt.set(path, now)
    const status = await window.nodeTerminal.git.status(path)
    if (!status) return
    set((s) => ({
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
    lastStatusAt.clear()
    set({ repoRoot: null, entries: [], orphans: [], staleGroupIds: [], statusByPath: {} })
  }
}))
