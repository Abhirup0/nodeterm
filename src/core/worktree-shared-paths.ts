// Materialize a project's `sharedPaths` from the repo root into a freshly-created git worktree.
//
// A git worktree gets its own working copy but shares the common `.git`. Anything git-ignored —
// `node_modules`, `.env`, local build caches — is NOT copied and would otherwise be missing in the
// worktree. `sharedPaths` lists the relative paths a project wants to appear in every worktree; we
// materialize each one as a symlink back to the repo-root copy.
//
// v1 is symlink-only (never copy/clone). Tradeoff, intended: a symlinked `node_modules` is the SAME
// tree as the repo's — no extra disk, no second `npm install`, but an edit or `npm install` inside
// the worktree writes through to the repo's copy. For dependency dirs that is the desired sharing;
// a future opt-in could copy instead for isolation.
//
// Every entry is handled fail-safe: this function NEVER throws. Each entry yields one result so the
// caller can report exactly what happened (linked / why skipped / errored).
//
// The symlink call is kept LOCAL here (node:fs.symlink) rather than added to fs-ops.ts: the fs-ops
// helpers all collapse failure to a boolean, but we must distinguish an EPERM (Windows file symlink
// without Developer Mode) from other errors and surface a typed per-entry result — a boolean helper
// would throw that information away. So the raw call lives in this module, wrapped per entry.

import { promises as fs } from 'fs'
import path from 'path'
import { isInsideDir, type SharedPathResult } from '../shared/worktree'

// The type lives in `shared/worktree.ts` so the renderer's `WorktreeApi` can name it without a
// wrong-direction import into core; re-exported here so this module's own callers/tests keep
// importing it from where it originated.
export type { SharedPathResult }

// Mirror of the sanitizer's relative-safety checks in src/shared/project-settings.ts
// (`hasTraversalSegment` + the absolute / Windows-drive rejection). Values are already sanitized at
// write time, but we RE-validate here at fs time as defense in depth — the on-disk settings file
// could have been hand-edited or arrived over the relay unsanitized.
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).includes('..')
}
function isRelativeSafe(entry: string): boolean {
  if (entry.length === 0) return false
  if (entry.startsWith('/') || entry.startsWith('\\')) return false
  if (WINDOWS_DRIVE_RE.test(entry)) return false
  if (hasTraversalSegment(entry)) return false
  return true
}

// First path segment, case-folded — so `.git`, `.GIT`, `.git/hooks` all trip the reserved guard.
function firstSegment(entry: string): string {
  return entry.split(/[/\\]/)[0].toLowerCase()
}

/** True when the path exists as a link/file/dir — LSTAT, so a broken symlink counts as present. */
async function lexists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

/** Realpath fully resolved, or `null` if it cannot be resolved (broken link / ENOENT race). Callers
 *  treat `null` as "fail closed" — an unresolvable path cannot be proven contained, so it is unsafe. */
async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

/** Realpath of the DEEPEST EXISTING ancestor of `p` (p itself if it exists, else walk up until a
 *  component exists), or `null` on failure. Used to contain a path we are about to CREATE: the leaf
 *  and some parents may not exist yet, but the first existing component realpath-resolves any
 *  intermediate symlink — so we can prove where a `mkdir -p` would actually land BEFORE running it. */
async function realpathDeepestExisting(p: string): Promise<string | null> {
  let cur = p
  // Walk up until an existing component is found. `path.dirname` is idempotent at the root, so the
  // `parent === cur` check terminates the loop rather than spinning on `/` (which always exists).
  for (;;) {
    if (await lexists(cur)) return realpathOrNull(cur)
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * Symlink each relative `sharedPath` from `repoRoot` into `worktreeRoot`. Pure fs, never throws;
 * returns a per-entry result list (one `SharedPathResult` per input, order preserved).
 */
export async function materializeSharedPaths(
  repoRoot: string,
  worktreeRoot: string,
  sharedPaths: string[]
): Promise<SharedPathResult[]> {
  const repoAbs = path.resolve(repoRoot)
  const wtAbs = path.resolve(worktreeRoot)
  const results: SharedPathResult[] = []

  for (const entry of sharedPaths) {
    results.push(await materializeOne(repoAbs, wtAbs, entry))
  }
  return results
}

async function materializeOne(
  repoAbs: string,
  wtAbs: string,
  entry: string
): Promise<SharedPathResult> {
  try {
    // (1) Re-validate relative-safe: absolute, `..` segment, or Windows drive → unsafe.
    if (!isRelativeSafe(entry)) return { path: entry, status: 'skipped-unsafe' }

    // (2) Reserved guard: the worktree already shares the common `.git` (git writes its own `.git`
    // FILE pointing at the gitdir). Never symlink over it or anything beneath it.
    if (firstSegment(entry) === '.git') return { path: entry, status: 'skipped-reserved' }

    const source = path.resolve(repoAbs, entry)
    const target = path.resolve(wtAbs, entry)

    // (3) Within-root assertion (defense in depth on top of the relative-safety check above).
    if (!isInsideDir(source, repoAbs) || !isInsideDir(target, wtAbs)) {
      return { path: entry, status: 'skipped-unsafe' }
    }

    // (4) Source missing → not an error: a fresh clone whose `node_modules` isn't installed yet.
    if (!(await lexists(source))) return { path: entry, status: 'skipped-missing-source' }

    // (4b) SOURCE realpath containment. The lexical check in (3) is path-string only, but the source
    // may resolve THROUGH a symlink the repo committed — `git worktree add` checks out attacker-
    // controllable tracked symlinks, so a lexical path check is insufficient. Realpath of the source
    // (it exists per (4)) is the authoritative containment check: a repo-internal symlink escaping
    // the repo must not let materialization surface content from OUTSIDE the repo. A legitimate
    // in-repo symlink (e.g. a relative link to another repo dir) resolves back under repoAbs and is
    // allowed. A realpath failure (broken link / ENOENT race) → fail closed as skipped-unsafe.
    // The root itself is realpath'd too, so a symlinked prefix (e.g. macOS `/tmp -> /private/tmp`)
    // in the root path doesn't spuriously make a legitimately-contained source look outside it.
    const realRepoAbs = await realpathOrNull(repoAbs)
    const realSource = await realpathOrNull(source)
    if (!realRepoAbs || !isInsideDir(realSource ?? undefined, realRepoAbs)) {
      return { path: entry, status: 'skipped-unsafe' }
    }

    // (5) Target exists (lstat, even a broken symlink) → never overwrite. This also protects the
    // worktree's own `.git` file and anything git already wrote into the tree.
    if (await lexists(target)) return { path: entry, status: 'skipped-exists' }

    // (6) Create the target's parent tree, then link. On Windows the symlink type matters (a file
    // link and a dir link are distinct); infer it from the source. On POSIX the type is ignored.
    const realWtAbs = await realpathOrNull(wtAbs)

    // (6a) PRE-mkdir containment. `mkdir -p` itself FOLLOWS intermediate symlinks, so for a deeper
    // entry like `cfg/deep/x` where the checked-out tree has `cfg -> /outside`, the mkdir would
    // create `/outside/deep` OUTSIDE the worktree root before the post-mkdir guard (6b) could reject
    // it (an empty-directory-creation primitive from a hostile repo). The containment check must
    // therefore run BEFORE the mkdir, not only after it: resolve the realpath of the deepest EXISTING
    // ancestor of the parent-to-create (which realpath-resolves any such intermediate symlink) and
    // assert it stays under the worktree root. Fail closed on realpath failure.
    const realDeepest = await realpathDeepestExisting(path.dirname(target))
    if (!realWtAbs || !isInsideDir(realDeepest ?? undefined, realWtAbs)) {
      return { path: entry, status: 'skipped-unsafe' }
    }

    await fs.mkdir(path.dirname(target), { recursive: true })

    // (6b) TARGET realpath containment — the authoritative guard against the symlink-plant escape.
    // The lexical check in (3) resolves `<wt>/cfg/x` as a string, but `git worktree add` may have
    // checked out an intermediate tracked symlink (e.g. `<wt>/cfg -> /outside`); `fs.symlink` would
    // then write THROUGH it and plant a link OUTSIDE the worktree root. The target's parent exists
    // post-mkdir, so realpath resolves any such intermediate symlink; assert the REAL parent stays
    // inside the worktree. A realpath failure → fail closed as skipped-unsafe.
    const realParent = await realpathOrNull(path.dirname(target))
    if (!realWtAbs || !isInsideDir(realParent ?? undefined, realWtAbs)) {
      return { path: entry, status: 'skipped-unsafe' }
    }

    let type: 'dir' | 'file' = 'file'
    try {
      if ((await fs.stat(source)).isDirectory()) type = 'dir'
    } catch {
      // Source vanished between checks — fall back to a file link; symlink() below will error out
      // cleanly if that too fails, and we return an `error` result rather than throwing.
    }
    await fs.symlink(source, target, type)
    return { path: entry, status: 'linked' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM on Windows = symlink creation needs Developer Mode / elevated rights. Surface it as an
    // error with a note instead of throwing out of the whole batch.
    const note =
      code === 'EPERM'
        ? 'symlink not permitted (on Windows, enable Developer Mode)'
        : (err as Error).message
    return { path: entry, status: 'error', note }
  }
}
