import {
  GIT_HISTORY_COMMIT_FORMAT,
  gitHistoryRefFromFullName,
  parseGitHistoryLog,
  shortGitHash
} from './git-history-log-parser'
import {
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  type GitHistoryExecutor,
  type GitHistoryItemRef,
  type GitHistoryOptions,
  type GitHistoryResult
} from './git-history-types'

export type {
  GitHistoryExecutor,
  GitHistoryGraphColorId,
  GitHistoryItem,
  GitHistoryItemRef,
  GitHistoryItemStatistics,
  GitHistoryOptions,
  GitHistoryRefCategory,
  GitHistoryResult
} from './git-history-types'
export {
  GIT_HISTORY_BASE_REF_COLOR,
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_LANE_COLORS,
  GIT_HISTORY_MAX_LIMIT,
  GIT_HISTORY_REF_COLOR,
  GIT_HISTORY_REMOTE_REF_COLOR
} from './git-history-types'
export {
  compareGitHistoryItemRefsByCategory,
  GIT_HISTORY_COMMIT_FORMAT,
  parseGitHistoryLog
} from './git-history-log-parser'

function clampHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return GIT_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(
    GIT_HISTORY_MAX_LIMIT,
    Math.max(1, Math.trunc(limit ?? GIT_HISTORY_DEFAULT_LIMIT))
  )
}

/**
 * `git rev-parse <flags> --end-of-options <ref>`, retrying WITHOUT the flag when the first call
 * fails: gits older than ~2.25 (Ubuntu 18.04 / Debian 10 era — still common on the SSH hosts
 * this loader now reaches) reject `--end-of-options` as an unknown option, and a rejected HEAD
 * probe reads as "no commits" — a silently empty history panel. The flag only guards
 * option-injection via a ref that starts with '-', and every caller refuses those refs before
 * calling, so the fallback loses no safety. A legitimately missing ref costs one extra rev-parse
 * and still throws, which is what callers expect.
 */
async function revParseCompat(
  git: GitHistoryExecutor,
  cwd: string,
  flags: string[],
  ref: string
): Promise<string> {
  try {
    const { stdout } = await git(['rev-parse', ...flags, '--end-of-options', ref], cwd)
    return stdout
  } catch {
    const { stdout } = await git(['rev-parse', ...flags, ref], cwd)
    return stdout
  }
}

async function resolveCommit(
  git: GitHistoryExecutor,
  cwd: string,
  ref: string
): Promise<string | null> {
  if (!ref || ref.startsWith('-')) {
    return null
  }
  try {
    const stdout = await revParseCompat(git, cwd, ['--verify'], `${ref}^{commit}`)
    const oid = stdout.trim()
    return oid || null
  } catch {
    return null
  }
}

async function resolveSymbolicFullName(
  git: GitHistoryExecutor,
  cwd: string,
  ref: string
): Promise<string | null> {
  if (!ref || ref.startsWith('-')) {
    return null
  }
  try {
    const stdout = await revParseCompat(git, cwd, ['--symbolic-full-name'], ref)
    return stdout.trim().split(/\r?\n/).find(Boolean) ?? null
  } catch {
    return null
  }
}

async function resolveCurrentRef(
  git: GitHistoryExecutor,
  cwd: string,
  headOid: string
): Promise<{ currentRef: GitHistoryItemRef; branchName: string | null }> {
  try {
    const { stdout } = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
    const branchName = stdout.trim()
    if (branchName) {
      return {
        branchName,
        currentRef: {
          id: `refs/heads/${branchName}`,
          name: branchName,
          revision: headOid,
          category: 'branches'
        }
      }
    }
  } catch {
    // Detached HEAD.
  }

  return {
    branchName: null,
    currentRef: { id: headOid, name: shortGitHash(headOid), revision: headOid, category: 'commits' }
  }
}

async function resolveUpstreamRef(
  git: GitHistoryExecutor,
  cwd: string,
  branchName: string | null
): Promise<GitHistoryItemRef | undefined> {
  if (!branchName) {
    return undefined
  }
  try {
    const { stdout } = await git(
      ['for-each-ref', '--format=%(upstream)%00%(upstream:short)', `refs/heads/${branchName}`],
      cwd
    )
    const [fullName, shortName] = stdout.split('\0')
    const upstreamRef = fullName?.trim()
    const upstreamShortName = shortName?.trim()
    if (!upstreamRef || !upstreamShortName) {
      return undefined
    }
    // Why: %(upstream:objectname) is not portable across Git versions; resolve
    // the upstream name first, then ask rev-parse for the commit object.
    const oid = await resolveCommit(git, cwd, upstreamRef)
    return oid ? gitHistoryRefFromFullName(upstreamRef, upstreamShortName, oid) : undefined
  } catch {
    return undefined
  }
}

async function resolveNamedRef(
  git: GitHistoryExecutor,
  cwd: string,
  ref: string | null | undefined
): Promise<GitHistoryItemRef | undefined> {
  const normalized = ref?.trim()
  if (!normalized || normalized.startsWith('-')) {
    return undefined
  }
  const [revision, fullName] = await Promise.all([
    resolveCommit(git, cwd, normalized),
    resolveSymbolicFullName(git, cwd, normalized)
  ])
  return revision ? gitHistoryRefFromFullName(fullName, normalized, revision) : undefined
}

export async function loadGitHistoryFromExecutor(
  git: GitHistoryExecutor,
  cwd: string,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  const limit = clampHistoryLimit(options.limit)
  const headOid = await resolveCommit(git, cwd, 'HEAD')
  if (!headOid) {
    return {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit
    }
  }

  const { currentRef, branchName } = await resolveCurrentRef(git, cwd, headOid)
  const [remoteRef, rawBaseRef] = await Promise.all([
    resolveUpstreamRef(git, cwd, branchName),
    resolveNamedRef(git, cwd, options.baseRef)
  ])

  const baseRef =
    rawBaseRef && rawBaseRef.id !== remoteRef?.id && rawBaseRef.id !== currentRef.id
      ? rawBaseRef
      : undefined

  // Why: this panel is scoped to the active workspace. Upstream and base refs
  // stay as comparison metadata so old workspaces do not list newly fetched upstream/base commits.
  const historyRevisions = [headOid]

  let mergeBase: string | undefined
  if (remoteRef?.revision && currentRef.revision && remoteRef.revision !== currentRef.revision) {
    try {
      const { stdout } = await git(['merge-base', currentRef.revision, remoteRef.revision], cwd)
      mergeBase = stdout.trim() || undefined
    } catch {
      mergeBase = undefined
    }
  }

  const { stdout } = await git(
    [
      'log',
      `--format=${GIT_HISTORY_COMMIT_FORMAT}`,
      '-z',
      '--topo-order',
      '--decorate=full',
      `-n${limit + 1}`,
      ...historyRevisions
    ],
    cwd
  )
  const parsed = parseGitHistoryLog(stdout)
  const items = parsed.slice(0, limit)
  const hasIncomingChanges =
    Boolean(remoteRef?.revision && mergeBase) && remoteRef?.revision !== mergeBase
  const hasOutgoingChanges =
    Boolean(currentRef.revision && remoteRef?.revision && mergeBase) &&
    currentRef.revision !== mergeBase

  return {
    items,
    currentRef,
    remoteRef,
    baseRef,
    mergeBase,
    hasIncomingChanges,
    hasOutgoingChanges,
    hasMore: parsed.length > limit,
    limit
  }
}
