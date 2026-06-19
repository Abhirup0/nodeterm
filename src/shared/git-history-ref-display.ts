import type { GitHistoryItemRef } from './git-history-types'

type DedupeRemoteTrackingRefsOptions = {
  preserveRefIds?: ReadonlySet<string> | readonly string[]
}

/** Split `origin/feature` into `{ remoteName, branchName }`; null if not splittable. */
function splitRemoteBranchName(refName: string): { remoteName: string; branchName: string } | null {
  const slashIndex = refName.indexOf('/')
  if (slashIndex <= 0 || slashIndex === refName.length - 1) {
    return null
  }
  return { remoteName: refName.slice(0, slashIndex), branchName: refName.slice(slashIndex + 1) }
}

function isAmbiguousRemoteTrackingRef(refName: string): boolean {
  // Without configured remote names, `foo/bar/main` is ambiguous; keep both pills.
  return refName.split('/').length > 2
}

function countUnambiguousMatchingRemoteBranches(
  refs: readonly GitHistoryItemRef[],
  localBranchNames: ReadonlySet<string>
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const ref of refs) {
    if (ref.category !== 'remote branches' || isAmbiguousRemoteTrackingRef(ref.name)) continue
    const split = splitRemoteBranchName(ref.name)
    if (!split || !localBranchNames.has(split.branchName)) continue
    counts.set(split.branchName, (counts.get(split.branchName) ?? 0) + 1)
  }
  return counts
}

// Drops a remote-tracking ref (origin/feature) when the matching local branch
// (feature) sits on the same commit — the two pills are redundant there.
export function dedupeRemoteTrackingRefs(
  refs: readonly GitHistoryItemRef[],
  options: DedupeRemoteTrackingRefsOptions = {}
): GitHistoryItemRef[] {
  const localBranchNames = new Set(
    refs.filter((ref) => ref.category === 'branches').map((ref) => ref.name)
  )
  if (localBranchNames.size === 0) return [...refs]
  const preserveRefIds = new Set(options.preserveRefIds ?? [])
  const matchingRemoteCounts = countUnambiguousMatchingRemoteBranches(refs, localBranchNames)
  return refs.filter((ref) => {
    if (ref.category !== 'remote branches') return true
    if (preserveRefIds.has(ref.id)) return true
    if (isAmbiguousRemoteTrackingRef(ref.name)) return true
    const split = splitRemoteBranchName(ref.name)
    if (!split || !localBranchNames.has(split.branchName)) return true
    return matchingRemoteCounts.get(split.branchName) !== 1
  })
}
