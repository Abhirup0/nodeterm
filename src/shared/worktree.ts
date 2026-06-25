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

export interface WorktreeEntry {
  path: string
  branch: string | null
  head: string | null
  isBare: boolean
}

/**
 * Reject refs that could smuggle CLI flags (leading `-`) or are not valid git refs.
 * Electron-free port of git-service.ts's `isValidRef` so worktree-ops can validate too.
 */
export function isValidGitRef(name: string): boolean {
  const n = name.trim()
  if (!n || n.startsWith('-')) return false
  return !/[\s~^:?*[\\]|\.\.|^\/|\/$|@\{/.test(n)
}

/** Flatten a branch name into a filesystem-safe, flag-safe slug. */
export function sanitizeWorktreeBranch(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-') // illegal chars -> dash
    .replace(/^[-/]+/, '')          // no leading dash (flag injection) or slash
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/** Default on-disk location: <userData>/worktrees/<repo>/<branch-flattened>. */
export function computeWorktreePath(userDataDir: string, repoName: string, branch: string): string {
  const flat = branch.replace(/\//g, '-')
  return `${userDataDir}/worktrees/${repoName}/${flat}`
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: Partial<WorktreeEntry> | null = null
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      if (cur) entries.push({ path: cur.path!, branch: cur.branch ?? null, head: cur.head ?? null, isBare: cur.isBare ?? false })
      cur = { path: line.slice('worktree '.length), isBare: false }
    } else if (!cur) {
      continue
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      cur.isBare = true
    }
  }
  if (cur) entries.push({ path: cur.path!, branch: cur.branch ?? null, head: cur.head ?? null, isBare: cur.isBare ?? false })
  return entries
}

const isAncestorPath = (parent: string, child: string): boolean => {
  const p = parent.replace(/\/+$/, '')
  const c = child.replace(/\/+$/, '')
  return c === p || c.startsWith(p + '/')
}

/** Refuse removals that would nuke the repo, home, or filesystem root. */
export function isDangerousWorktreeRemovalPath(worktreePath: string, repoPath: string, homeDir: string): boolean {
  const wt = (worktreePath || '').replace(/\/+$/, '')
  if (!wt) return true
  if (wt === '/' || wt === repoPath.replace(/\/+$/, '') || wt === homeDir.replace(/\/+$/, '')) return true
  // worktree is an ancestor of the repo or of home → dangerous.
  if (isAncestorPath(wt, repoPath) || isAncestorPath(wt, homeDir)) return true
  return false
}

/** Choose how to land a branch onto its base without corrupting a live checkout. */
export function decideMergeStrategy(args: { baseCheckedOutPath: string | null; baseDirty: boolean }):
  | { kind: 'fetch-update' }
  | { kind: 'merge-in-place'; path: string }
  | { kind: 'blocked'; reason: string } {
  if (args.baseCheckedOutPath === null) return { kind: 'fetch-update' }
  if (args.baseDirty) {
    return { kind: 'blocked', reason: 'The base branch checkout has uncommitted changes. Commit or stash them first.' }
  }
  return { kind: 'merge-in-place', path: args.baseCheckedOutPath }
}
