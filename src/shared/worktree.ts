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
  /**
   * git still LISTS a worktree whose directory was deleted behind its back — it just tags it
   * `prunable` (until someone runs `git worktree prune`). Treating such an entry as alive is what
   * makes a dead binding look healthy, so the flag has to survive the parse.
   */
  prunable?: boolean
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

/**
 * Default on-disk location: <userData>/worktrees/<repo>/<branch-flattened>.
 * An unknown base dir yields NO suggestion (empty string) rather than a root-relative
 * `/worktrees/...` — the Server Edition often runs as root and `git worktree add` would
 * cheerfully create that at the filesystem root. Callers must treat '' as "no default".
 */
export function computeWorktreePath(userDataDir: string, repoName: string, branch: string): string {
  const base = userDataDir.trim().replace(/\/+$/, '')
  if (!base) return ''
  const flat = branch.replace(/\//g, '-')
  return `${base}/worktrees/${repoName}/${flat}`
}

/** Values the worktree dialog collects. Mapped to a `GroupWorktree` by `worktreeFromCreate`. */
export interface WorktreeCreateValue {
  repoPath: string
  mode: 'new' | 'existing'
  branch: string
  baseRef: string
  path: string
}

/** Last-resort merge target when the repo's default branch cannot be read. */
export const DEFAULT_BASE_REF = 'main'

/**
 * The repo's default branch = the branch of its MAIN checkout, which git prints FIRST in
 * `git worktree list` (the caller must keep git's order). Hardcoding 'main' would send a
 * master/trunk repo's merge at a ref that does not exist.
 */
export function resolveBaseRef(entries: WorktreeEntry[]): string {
  return entries[0]?.branch?.trim() || DEFAULT_BASE_REF
}

/**
 * Binding for a worktree THIS APP just created — `createdByApp: true` grants Remove the right
 * to delete the directory. Only call this after `git worktree add` succeeded.
 */
export function worktreeFromCreate(v: WorktreeCreateValue): GroupWorktree {
  return {
    repoPath: v.repoPath.trim(),
    branch: v.branch.trim(),
    baseRef: v.baseRef.trim() || DEFAULT_BASE_REF,
    path: v.path.trim(),
    createdByApp: true
  }
}

/**
 * Binding for a worktree that ALREADY EXISTED on disk (adopted from `git worktree list`) —
 * `createdByApp: false`, so Remove must never delete a directory the user made themselves.
 * Returns null when the binding cannot be trusted (detached HEAD, unknown repo root/path).
 */
export function worktreeFromEntry(
  entry: WorktreeEntry,
  repoPath: string,
  baseRef: string
): GroupWorktree | null {
  const path = entry.path.trim()
  const branch = entry.branch?.trim()
  const repo = repoPath.trim()
  if (!repo || !branch || !path) return null
  return {
    repoPath: repo,
    branch,
    baseRef: baseRef.trim() || DEFAULT_BASE_REF,
    path,
    createdByApp: false
  }
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: Partial<WorktreeEntry> | null = null
  const flush = (c: Partial<WorktreeEntry>): void => {
    entries.push({
      path: c.path!,
      branch: c.branch ?? null,
      head: c.head ?? null,
      isBare: c.isBare ?? false,
      prunable: c.prunable ?? false
    })
  }
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      if (cur) flush(cur)
      cur = { path: line.slice('worktree '.length), isBare: false }
    } else if (!cur) {
      continue
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      cur.isBare = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      // e.g. "prunable gitdir file points to non-existent location" — the directory is gone.
      cur.prunable = true
    }
  }
  if (cur) flush(cur)
  return entries
}

/** Is `child` the directory `parent` itself, or somewhere inside it? (Trailing slashes ignored.) */
export const isAncestorPath = (parent: string, child: string): boolean => {
  const p = parent.replace(/\/+$/, '')
  const c = child.replace(/\/+$/, '')
  return c === p || c.startsWith(p + '/')
}

/** `isAncestorPath` for an optional cwd: "does this node live in that directory?" */
export const isInsideDir = (cwd: string | undefined, dir: string): boolean =>
  !!cwd && !!dir && isAncestorPath(dir, cwd)

/**
 * Every node under `rootId` — children, grandchildren, … — not just the direct children.
 *
 * Worktree teardown has to reach ALL of them: a terminal inside a nested group is living in the
 * worktree directory just as much as a direct child, and a removal that only walked one level left
 * it holding a session (and a cwd) in a directory that no longer exists.
 */
export function descendantIds(
  nodes: readonly { id: string; parentId?: string }[],
  rootId: string
): Set<string> {
  const byParent = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    const siblings = byParent.get(n.parentId) ?? []
    siblings.push(n.id)
    byParent.set(n.parentId, siblings)
  }
  const out = new Set<string>()
  const stack = [...(byParent.get(rootId) ?? [])]
  while (stack.length) {
    const id = stack.pop() as string
    if (out.has(id)) continue // cycle guard: a corrupt parentId chain must not hang the app
    out.add(id)
    stack.push(...(byParent.get(id) ?? []))
  }
  return out
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
