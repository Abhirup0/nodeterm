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
export interface WorktreeOpResult {
  ok: boolean
  message: string
  /**
   * `worktreeRemove` only: the worktree is no longer on disk (its registration was pruned, or it
   * was never registered). The caller MUST clear its binding even when `ok` is false — otherwise a
   * group whose directory was deleted behind git's back can never be cleaned up: removal keeps
   * failing and the dead path keeps being handed to new terminals.
   */
  worktreeGone?: boolean
}

export async function repoRoot(git: GitExecutor, cwd: string): Promise<string | null> {
  if (!cwd) return null
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.out.trim() : null
}

/**
 * Does this path exist on disk? Injected (the shared layer has no fs) — the real one is wired in
 * `git-service`. Defaults to "it exists": the conservative answer, which never deletes anything and
 * never calls a live worktree missing.
 */
export type PathExists = (p: string) => Promise<boolean>

const alwaysExists: PathExists = async () => true

/**
 * List a repo's worktrees, with `prunable` made TRUE for any entry whose directory is not on disk.
 *
 * git only emits the `prunable` tag from **2.36**. Debian 11 / Ubuntu 20.04 — the Server Edition's
 * own target platform — ship git 2.30, where a worktree whose directory was deleted behind git's
 * back is listed as perfectly healthy. Everything downstream reads `prunable` as "the directory is
 * gone": `reconcileWorktrees` would call a dead binding live (chip healthy, "↪ Move into worktree"
 * still clickable → it kills a running session and respawns it into a directory that no longer
 * exists) and the bind dialog would offer the vanished directory as an adoptable orphan.
 *
 * So we do not trust the tag alone: stat every entry and OR the result in. Same seam, same
 * conservative default as `worktreeRemove`'s.
 */
export async function worktreeList(
  git: GitExecutor,
  repoPath: string,
  pathExists: PathExists = alwaysExists
): Promise<WorktreeEntry[]> {
  if (!repoPath) return []
  const r = await git(repoPath, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const entries = parseWorktreePorcelain(r.out)
  return Promise.all(
    entries.map(async (e) => ({ ...e, prunable: e.prunable || !(await pathExists(e.path)) }))
  )
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

/**
 * Merge `branch` into `baseRef`, and — only when `push` is true AND the repo actually has an
 * `origin` — publish the base branch to origin.
 *
 * The push is OPT-IN by design. It used to run "best effort" on every merge: one click on a small
 * header chip published to `origin/main` (CI, teammates, protected-branch noise) without the confirm
 * dialog ever mentioning it. Nothing here may do more than the caller disclosed to the user, so the
 * default is not to push, and the result message states exactly what happened.
 */
export async function worktreeMerge(
  git: GitExecutor, repoPath: string, branch: string, baseRef: string, push = false,
  /** See `PathExists` / `worktreeList`. Without it, a base checkout whose directory was deleted
   *  behind git's back is listed as healthy and `decideMergeStrategy` merges INTO A DIRECTORY THAT
   *  IS NOT THERE — the merge fails and the user is told to resolve a conflict that does not exist
   *  in a directory that does not exist. */
  pathExists: PathExists = alwaysExists
): Promise<WorktreeOpResult> {
  if (!isValidGitRef(branch) || !isValidGitRef(baseRef)) return { ok: false, message: 'Invalid ref.' }
  const list = await worktreeList(git, repoPath, pathExists)
  const baseEntry = list.find((e) => e.branch === baseRef) ?? null
  // The base branch is checked out in a worktree whose directory is GONE. Do not merge in place
  // (nothing to merge into) and do not quietly fall through to `fetch-update` either: git still has
  // the registration and refuses to update a ref that is checked out elsewhere, so that would fail
  // with an obscure message. Say what is actually wrong.
  if (baseEntry?.prunable) {
    return {
      ok: false,
      message:
        `The checkout of ${baseRef} is missing (${baseEntry.path}). ` +
        `Restore that directory or run \`git worktree prune\`, then try again.`
    }
  }
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
      // The merge ran in the BASE checkout, so that is where the conflict is — sending the user to
      // the worktree terminal (as this message used to) points at the wrong directory entirely.
      return {
        ok: false,
        message: `Merge conflict in the base checkout (${plan.path}). Resolve it there, then try again.`
      }
    }
  }
  const merged = `Merged ${branch} into ${baseRef}.`
  if (!push) return { ok: true, message: merged }
  // The push below is hardcoded to `origin`, so "some remote exists" is not the question: a fork
  // whose only remote is `upstream` would fail here after being promised an origin push. Only push
  // when `origin` itself is there — never claim (or attempt) a publish that cannot happen.
  const remotes = (await git(repoPath, ['remote'])).out.split('\n').map((r) => r.trim())
  if (!remotes.includes('origin')) return { ok: true, message: merged }
  const p = await git(repoPath, ['push', 'origin', baseRef])
  // A failed push does not undo the merge, so this stays `ok` — but it is reported, not swallowed:
  // the user must know whether origin has the merge.
  return p.ok
    ? { ok: true, message: `Merged ${branch} into ${baseRef} and pushed ${baseRef} to origin.` }
    : { ok: true, message: `${merged} The push to origin failed — push ${baseRef} manually.` }
}

/**
 * Remove a worktree (and optionally its branch).
 *
 * `pruneOnly` = clean up git's REGISTRATION only, never the filesystem. It is what a stale binding
 * (directory deleted behind git's back) needs: without a prune, git keeps listing the path and a
 * later `git worktree add` at the same place fails with "missing but already registered worktree".
 * A directory that still exists is left completely alone in that mode — a wrongly-stale group must
 * never be able to delete a live checkout.
 */
export async function worktreeRemove(
  git: GitExecutor, repoPath: string, wtPath: string, homeDir: string, deleteBranch: boolean,
  pruneOnly = false,
  /** See `PathExists` / `worktreeList`: git's `prunable` flag needs git ≥ 2.36; the stat is the
   *  fallback that makes every older git tell the truth about a deleted directory. */
  pathExists: PathExists = alwaysExists
): Promise<WorktreeOpResult> {
  // Reject a path that could be parsed as an option flag (argv injection).
  if (!wtPath || wtPath.startsWith('-')) return { ok: false, message: 'Invalid worktree path.' }
  if (isDangerousWorktreeRemovalPath(wtPath, repoPath, homeDir)) {
    return { ok: false, message: 'Refusing to remove that path.' }
  }
  const list = await worktreeList(git, repoPath, pathExists)
  const entry = list.find((e) => e.path.replace(/\/+$/, '') === wtPath.replace(/\/+$/, ''))
  if (!entry) {
    // Nothing to remove: git does not know this path (deleted + already pruned, or never a
    // worktree of this repo). Prune anyway — a leftover registration elsewhere would block a
    // future `worktree add` — and tell the caller the worktree is gone so it clears its binding.
    // (Unconditionally: pruning is the whole point of `pruneOnly`, so skipping it there was
    // exactly backwards.)
    await git(repoPath, ['worktree', 'prune'])
    return { ok: false, worktreeGone: true, message: 'Worktree is not registered — it is already gone.' }
  }
  const branch = entry.branch
  // git still lists it, but is the directory actually there? `prunable` is git's own answer
  // (≥ 2.36); the stat is the fallback for older gits, which never set the flag.
  const dirGone = entry.prunable || !(await pathExists(wtPath))
  if (dirGone) {
    // The directory is gone. `worktree remove` would fail; prune the registration instead and
    // touch no files.
    await git(repoPath, ['worktree', 'prune'])
    if (!pruneOnly && deleteBranch && branch && isValidGitRef(branch)) {
      await git(repoPath, ['branch', '-d', branch])
    }
    return {
      ok: true,
      worktreeGone: true,
      message: 'The worktree directory was already gone; its registration was pruned.'
    }
  }
  if (pruneOnly) {
    return { ok: false, message: 'The worktree directory still exists; nothing was pruned.' }
  }
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
