import type { GroupWorktree, WorktreeEntry } from './worktree'

/** A group node that carries a worktree binding. */
export interface BoundGroup {
  groupId: string
  worktree: GroupWorktree
}

/**
 * live    — group ids whose bound worktree is still registered with git.
 * stale   — group ids whose worktree is gone from disk (deleted outside the app).
 * orphans — worktrees on disk that no group is bound to (every Unbind makes one).
 */
export interface Reconciliation {
  live: string[]
  stale: string[]
  orphans: WorktreeEntry[]
}

const norm = (p: string): string => p.trim().replace(/\/+$/, '')

/**
 * Compare the persisted bindings against `git worktree list`. The FIRST entry git prints is the
 * main checkout — it is never an orphan (offering it as one would invite deleting the repo), and
 * bare entries are not worktrees a group can own.
 */
export function reconcileWorktrees(bound: BoundGroup[], entries: WorktreeEntry[]): Reconciliation {
  const usable = entries.filter((e) => !e.isBare)
  const mainCheckout = usable[0]?.path
  const onDisk = new Set(usable.map((e) => norm(e.path)))
  const boundPaths = new Set(bound.map((b) => norm(b.worktree.path)))

  const live: string[] = []
  const stale: string[] = []
  for (const b of bound) {
    ;(onDisk.has(norm(b.worktree.path)) ? live : stale).push(b.groupId)
  }

  const orphans = usable.filter(
    (e) => norm(e.path) !== norm(mainCheckout ?? '') && !boundPaths.has(norm(e.path))
  )

  return { live, stale, orphans }
}
