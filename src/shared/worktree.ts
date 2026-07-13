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

/** `git worktree list`, plus WHETHER GIT COULD BE READ AT ALL — see `worktree-ops.listWorktrees`. */
export interface WorktreeListResult {
  ok: boolean
  entries: WorktreeEntry[]
}

/** The node fields that can say "this session does not run on this machine". */
interface RemoteNodeLike {
  /** Relay-bound node (`createRemoteTerminalNode`) — not persisted. */
  remote?: unknown
  /** SSH-PROJECT terminal (`createTerminalNode(..., project.ssh)`) — the connection it runs on. */
  ssh?: unknown
  /** SSH-PROJECT terminal: its tmux server lives on the host, not here. */
  sshRemoteTmux?: unknown
}

/**
 * Does this node's session live on a REMOTE host?
 *
 * Worktrees are local-only in v1: the path is computed from the LOCAL data dir and `git worktree`
 * runs against the LOCAL filesystem. A node whose tmux session is on another machine must therefore
 * never be moved into one — its session would be destroyed and respawned into a directory that does
 * not exist there, and the dead path would be persisted to `project.json`.
 *
 * THREE different fields mean "remote", and guarding only one is how the exact node this protects
 * slipped through: `data.remote` is set ONLY by `createRemoteTerminalNode` (relay nodes, never
 * persisted, never inside an SSH project), while an SSH-PROJECT terminal carries `data.ssh` +
 * `data.sshRemoteTmux` and NEVER `data.remote`. Ask about all of them.
 */
export function isRemoteSessionNode(data: RemoteNodeLike | undefined): boolean {
  return !!(data && (data.remote || data.ssh || data.sshRemoteTmux))
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

/**
 * Resolve the on-disk worktree directory for a create: an explicit `--path` wins; otherwise the
 * default under the SESSION CORE's writable base (`userDataDir()` — the HOST's userData for a
 * remote tab, so the worktree lands on the machine `git worktree add` runs on, not this client).
 *
 * `userDataDir` is injected (not read off any global) precisely so the path follows the session
 * that runs the git op — the obligation-c fix. Async because the base dir is fetched from the core;
 * a given `--path` short-circuits it, so the provider is never touched when the caller already knows
 * the location. Returns '' when nothing can be derived (an unknown base and no `--path`).
 */
export async function resolveWorktreePath(args: {
  explicitPath?: string
  userDataDir: () => Promise<string>
  repoRoot: string
  branch: string
}): Promise<string> {
  const explicit = args.explicitPath?.trim()
  if (explicit) return explicit
  return computeWorktreePath(await args.userDataDir(), args.repoRoot.split('/').pop() || 'repo', args.branch)
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

/** The shape `displacedByWorktree` needs of a canvas node (structural, so the shared layer stays
 *  free of React Flow types). */
interface WorktreeNodeLike {
  id: string
  type?: string
  parentId?: string
  data?: { cwd?: unknown; filePath?: unknown }
}

/**
 * The nodes a worktree teardown DISPLACES: every descendant of the bound group that carries a
 * working directory (a terminal or a chat) inside the worktree path, PLUS any editor/diff node
 * anywhere on the canvas whose file lives inside it.
 *
 * BOTH teardown paths derive from this — Remove (which also ends their sessions and respawns them)
 * and a stale group's Unbind (which touches no process at all). Unbind is the documented recovery
 * path for a worktree deleted outside the app — the only action a stale group offers — and leaving
 * `data.cwd` on the dead path there is not cosmetic: it is persisted to `project.json`, tmux hides
 * it (a warm reattach ignores cwd), and the next machine reboot cold-starts the terminal into a
 * directory that no longer exists, where pty-manager silently falls back to $HOME while the dead
 * path stays in the project file forever.
 *
 * Nodes whose cwd was never inside the worktree (pointed elsewhere by hand, a sibling directory
 * that merely shares the prefix, no cwd at all) are NOT displaced — they were never affected, and
 * rewriting them would be a change the user never asked for.
 *
 * Terminal/chat displacement is GROUP-scoped (`under.has`) because a cwd match alone is too broad —
 * plenty of terminals legitimately share a cwd with a worktree without living inside its frame.
 * Editor/diff nodes get no such scoping: `createEditorNode`/`createDiffNode` never set a
 * `parentId` (they float free on the canvas, `group: null`), so they are never a "descendant" of
 * anything — path containment is the only signal there is. A node that opened a file out of a
 * worktree is displaced by that worktree going away no matter where it happens to sit visually.
 * Editor stores the file's ABSOLUTE path in `filePath`; diff stores the repo root in `cwd` and the
 * file's path RELATIVE to it in `filePath`, so the two are joined before the containment check.
 */
export function displacedByWorktree(
  nodes: readonly WorktreeNodeLike[],
  groupId: string,
  worktreePath: string
): Set<string> {
  if (!worktreePath) return new Set()
  const under = descendantIds(nodes, groupId)
  const out = new Set<string>()
  for (const n of nodes) {
    if (n.type === 'terminal' || n.type === 'chat') {
      if (!under.has(n.id)) continue
      const cwd = typeof n.data?.cwd === 'string' ? n.data.cwd : undefined
      if (isInsideDir(cwd, worktreePath)) out.add(n.id)
    } else if (n.type === 'editor' || n.type === 'diff') {
      const filePath = typeof n.data?.filePath === 'string' ? n.data.filePath : undefined
      const cwd = typeof n.data?.cwd === 'string' ? n.data.cwd : undefined
      const abs = n.type === 'diff' && cwd && filePath ? `${cwd}/${filePath}` : filePath
      if (isInsideDir(abs, worktreePath)) out.add(n.id)
    }
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

/** What the removal confirm needs to say — WHO asked, and WHAT exactly gets destroyed. */
export interface WorktreeRemovePrompt {
  branch: string
  path: string
  /** nodeterm created the directory → deleting it is the action; otherwise Unbind is the default. */
  canDelete: boolean
  /** The live value of the "delete from disk too" box (for an adopted worktree). */
  deleteFromDisk: boolean
  /** e.g. "3 uncommitted file(s) in the worktree." */
  warning?: string
  /** Title of the AGENT that asked for this. Absent = the user asked for it themselves. */
  requestedBy?: string
}

/**
 * The removal dialog's text. Pure, so it can be read (and tested) without the canvas.
 *
 * Two things it must never omit again:
 *  - ATTRIBUTION. An agent can open this dialog (canvas-control `close-worktree --mode remove`).
 *    The old text was byte-identical to a user-initiated removal, so a user who never asked for it
 *    had no way to tell where it came from — while `write`/`close` have always said
 *    `Agent "<title>" wants to …`.
 *  - THE TARGET. It named neither the branch nor the directory, so an agent could open it for one
 *    worktree and the user could approve the deletion of a worktree they never looked at.
 */
export function worktreeRemoveMessage(p: WorktreeRemovePrompt): string {
  const who = p.requestedBy
    ? `Agent "${p.requestedBy}" wants to remove this worktree.\n\n`
    : ''
  const what = `Branch: ${p.branch}\nDirectory: ${p.path}\n\n`
  const body = p.canDelete
    ? // Promise only what we will actually do. `git branch -d` REFUSES an unmerged branch (and we
      // never escalate to -D), so "its branch is deleted" was a promise the op could not keep.
      'Remove this worktree? Its directory is deleted, and its branch too — unless the branch ' +
      'still has unmerged commits, in which case it is kept.'
    : 'This worktree was not created by nodeterm.\n\nUnbind detaches this group and leaves the ' +
      'worktree untouched on disk.'
  const optIn =
    p.deleteFromDisk && !p.canDelete
      ? '\n\n⚠ The worktree directory will be DELETED. Its branch is kept.'
      : ''
  const warn = p.warning ? `\n\n⚠ ${p.warning}` : ''
  return `${who}${what}${body}${optIn}${warn}`
}
