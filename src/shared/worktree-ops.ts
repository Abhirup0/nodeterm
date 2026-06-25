import {
  parseWorktreePorcelain,
  isDangerousWorktreeRemovalPath,
  decideMergeStrategy,
  isValidGitRef,
  type WorktreeEntry
} from './worktree'

/** One git invocation's result (mirrors git-service.ts's internal `Exec`). */
export interface GitExec { ok: boolean; out: string; err: string }
/** Injected git runner: runs `git <args>` in `cwd`. */
export type GitExecutor = (cwd: string, args: string[]) => Promise<GitExec>
/** Renderer-facing result (structurally a `GitResult`). */
export interface WorktreeOpResult { ok: boolean; message: string }

export async function repoRoot(git: GitExecutor, cwd: string): Promise<string | null> {
  if (!cwd) return null
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.out.trim() : null
}

export async function worktreeList(git: GitExecutor, repoPath: string): Promise<WorktreeEntry[]> {
  if (!repoPath) return []
  const r = await git(repoPath, ['worktree', 'list', '--porcelain'])
  return r.ok ? parseWorktreePorcelain(r.out) : []
}

export async function worktreeAdd(
  git: GitExecutor, repoPath: string, wtPath: string, branch: string, baseRef: string, isNew: boolean
): Promise<WorktreeOpResult> {
  if (!repoPath || !wtPath) return { ok: false, message: 'Missing repo or worktree path.' }
  // Reject a path that could be parsed as an option flag (argv injection).
  if (wtPath.startsWith('-')) return { ok: false, message: 'Invalid worktree path.' }
  if (!isValidGitRef(branch)) return { ok: false, message: 'Invalid branch name.' }
  if (isNew && !isValidGitRef(baseRef)) return { ok: false, message: 'Invalid base ref.' }
  // `--no-track` so a new branch does not inherit upstream and report "behind".
  // `--` ends option parsing so wtPath can never be read as a flag (verified git ≥2.39).
  const args = isNew
    ? ['worktree', 'add', '--no-track', '-b', branch, '--', wtPath, baseRef]
    : ['worktree', 'add', '--', wtPath, branch]
  const r = await git(repoPath, args)
  return r.ok ? { ok: true, message: `Worktree ready at ${wtPath}.` } : { ok: false, message: r.err }
}

export async function worktreeMerge(
  git: GitExecutor, repoPath: string, branch: string, baseRef: string
): Promise<WorktreeOpResult> {
  if (!isValidGitRef(branch) || !isValidGitRef(baseRef)) return { ok: false, message: 'Invalid ref.' }
  const list = await worktreeList(git, repoPath)
  const baseEntry = list.find((e) => e.branch === baseRef) ?? null
  let baseDirty = false
  if (baseEntry) {
    const st = await git(baseEntry.path, ['status', '--porcelain'])
    baseDirty = st.ok && st.out.trim().length > 0
  }
  const plan = decideMergeStrategy({ baseCheckedOutPath: baseEntry?.path ?? null, baseDirty })
  if (plan.kind === 'blocked') return { ok: false, message: plan.reason }

  if (plan.kind === 'fetch-update') {
    // Base not checked out anywhere → advance the ref without touching a working tree.
    const r = await git(repoPath, ['fetch', '.', `${branch}:${baseRef}`])
    if (!r.ok) return { ok: false, message: `Cannot fast-forward ${baseRef}. Merge manually in a terminal.` }
  } else {
    // Base is checked out and clean → merge in that checkout.
    const r = await git(plan.path, ['merge', '--no-ff', '--no-edit', branch])
    if (!r.ok) {
      await git(plan.path, ['merge', '--abort'])
      return { ok: false, message: 'Merge conflict. Resolve it in the worktree terminal.' }
    }
  }
  // Best-effort push if a remote exists; ignore failure (offline / no remote).
  const hasRemote = (await git(repoPath, ['remote'])).out.trim().length > 0
  if (hasRemote) await git(repoPath, ['push', 'origin', baseRef])
  return { ok: true, message: `Merged ${branch} into ${baseRef}.` }
}

export async function worktreeRemove(
  git: GitExecutor, repoPath: string, wtPath: string, homeDir: string, deleteBranch: boolean
): Promise<WorktreeOpResult> {
  // Reject a path that could be parsed as an option flag (argv injection).
  if (!wtPath || wtPath.startsWith('-')) return { ok: false, message: 'Invalid worktree path.' }
  if (isDangerousWorktreeRemovalPath(wtPath, repoPath, homeDir)) {
    return { ok: false, message: 'Refusing to remove that path.' }
  }
  const list = await worktreeList(git, repoPath)
  const entry = list.find((e) => e.path.replace(/\/+$/, '') === wtPath.replace(/\/+$/, ''))
  if (!entry) return { ok: false, message: 'Worktree is not registered.' }
  const branch = entry.branch
  // `--` ends option parsing so wtPath can never be read as a flag (verified git ≥2.39).
  const rm = await git(repoPath, ['worktree', 'remove', '--force', '--', wtPath])
  if (!rm.ok) return { ok: false, message: rm.err }
  await git(repoPath, ['worktree', 'prune'])
  if (deleteBranch && branch && isValidGitRef(branch)) {
    // -d refuses unmerged; the renderer decides whether to escalate to -D.
    await git(repoPath, ['branch', '-d', branch])
  }
  return { ok: true, message: 'Worktree removed.' }
}
