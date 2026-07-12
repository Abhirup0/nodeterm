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
  /** A remote named `origin` exists — i.e. a merge CAN publish the base branch to origin. The merge
   *  confirm reads this to offer the push (and to not threaten one that could never happen). It is
   *  deliberately NOT `hasRemote` ("any remote"): the push is hardcoded to `origin`, so a fork whose
   *  only remote is `upstream` would be shown a push it cannot perform. */
  hasOrigin: boolean
}

/** The chip re-renders constantly; without this, every render would spawn a `git status`. */
export const WORKTREE_STATUS_THROTTLE_MS = 4000

/**
 * How many CONSECUTIVE "this is not a repo" reads it takes to declare a bound worktree missing.
 *
 * `git.status()` answers `hasRepo:false` whenever `git rev-parse --is-inside-work-tree` merely
 * FAILS — a spawn EAGAIN under load, an NFS/FUSE hiccup — not only when the directory is gone. One
 * such read used to flip a perfectly healthy group to "missing"; it self-heals on the next poll,
 * but in that window `cwdForNewNodeIn` refuses the worktree path and hands out the project cwd, and
 * a terminal created then persists the WRONG cwd forever. Two reads in a row is the stronger signal.
 */
export const WORKTREE_STALE_STRIKES = 2

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
 * Consecutive `hasRepo:false` reads per worktree path (see WORKTREE_STALE_STRIKES). Reset by any
 * success. Keyed by the NORMALIZED path so `refresh` can look a binding up in it.
 */
const missStreak = new Map<string, number>()

/** Has this path been read as "not a repo" often enough in a row to count as gone? */
const struckOut = (p: string): boolean =>
  (missStreak.get(normWorktreePath(p)) ?? 0) >= WORKTREE_STALE_STRIKES

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
      // A miss-streak is a fact about a BINDING, not about a path forever. It is keyed by path and
      // `computeWorktreePath` is deterministic, so a streak that outlives its binding comes back to
      // haunt the next one: delete a worktree dir → the group strikes out → Unbind (which prunes)
      // → create a worktree for the same branch → the SAME path → the union below drags the dead
      // streak onto a brand-new, healthy group, which renders "· missing" (Merge/Remove/↪ hidden)
      // until the next successful poll. So the moment a path is no longer bound to any group
      // (unbind / remove / ungroup / delete — all of which re-refresh), forget its streak.
      // Only BOUND paths are ever consulted below, so nothing else can depend on it.
      const boundPaths = new Set(bound.map((b) => normWorktreePath(b.worktree.path)))
      for (const key of [...missStreak.keys()]) if (!boundPaths.has(key)) missStreak.delete(key)
      // Reconcile only the groups bound to THIS repo. A group bound to another repo's worktree
      // (legacy binding, or hand-typed) would otherwise be compared against the wrong entry list
      // and falsely reported stale.
      const mine = bound.filter(
        (b) => normWorktreePath(b.worktree.repoPath) === normWorktreePath(root)
      )
      const { stale, orphans } = reconcileWorktrees(mine, entries)
      // UNION, never replace. Staleness has two sources: git's own facts (`reconcileWorktrees`, via
      // `prunable`) and the status poll's miss-streak. `refresh()` runs on a project switch, on
      // binding another worktree, on deleting a node, on ungrouping — and setting `staleGroupIds`
      // to reconcile's answer alone would ERASE, on any of those, a group the poll had already
      // proven dead: the chip goes healthy again and "↪ Move into worktree" reopens the very window
      // in which it kills a live session into a directory that no longer exists.
      // Struck-out over ALL bindings, not just `mine`: a group bound to ANOTHER repo (a legacy or
      // hand-edited binding) is excluded from reconciliation by design, but its miss-streak is
      // still a fact about its own path. Filtering it out here dropped it from `staleGroupIds` on
      // every refresh, so a dead cross-repo worktree looked healthy again until the next poll tick.
      const struck = bound.filter((b) => struckOut(b.worktree.path)).map((b) => b.groupId)
      const staleIds = [...new Set([...stale, ...struck])]
      set({ repoRoot: root, entries, orphans, staleGroupIds: staleIds })
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
    // tells that story, so mark the group stale instead of keeping a lie on screen. But only once
    // the reading REPEATS: a single failed read is as likely to be a transient git failure as a
    // deleted directory, and calling a live worktree missing has consequences of its own.
    if (!status.hasRepo) {
      const key = normWorktreePath(path)
      const strikes = (missStreak.get(key) ?? 0) + 1
      missStreak.set(key, strikes)
      if (groupId && strikes >= WORKTREE_STALE_STRIKES) {
        set((s) =>
          s.staleGroupIds.includes(groupId)
            ? s
            : { staleGroupIds: [...s.staleGroupIds, groupId] }
        )
      }
      return
    }
    missStreak.delete(normWorktreePath(path))
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
          behind: status.behind,
          hasOrigin: !!status.hasOrigin
        }
      }
    }))
  },

  reset() {
    epoch++
    lastStatusAt.clear()
    missStreak.clear()
    set({ ...empty(), statusByPath: {} })
  }
}))
