export interface GroupWorktree {
  /** Main repo root chosen at bind time. */
  repoPath: string
  /** The worktree's branch (new or existing). */
  branch: string
  /** Branch this was created from — the merge target (e.g. "main"). */
  baseRef: string
  /** Worktree directory on disk. */
  path: string
  /** Whether this app created the worktree (gates safe directory deletion). */
  createdByApp: boolean
}
