import type { ProjectLaunchInfo } from '@shared/project-settings'

/**
 * Warmed renderer cache of `project-settings:launch-info` (`projectLaunchInfoNow` /
 * `ensureProjectLaunchInfo` / `invalidateProjectLaunchInfo`) — the `permissionMode.ts`
 * `ensureClaudeCliCaps`/`claudeCliCapsNow` shape, keyed per project instead of app-global.
 *
 * Module-level, NOT zustand: nothing renders directly off this — it is read at the moment a launch
 * needs to know whether a shared-sourced value is trusted, same reasoning permissionMode.ts gives
 * for its own memo.
 *
 * `cache`/`generation` are BOTH keyed by projectId so one project's invalidate never disturbs
 * another's warm entry. `generation` exists solely to keep an ABANDONED fetch from clobbering a
 * fresher one: `invalidateProjectLaunchInfo` bumps it and drops the in-flight entry so the next
 * `ensure` starts a real new request, but the OLD request (already in flight) is not cancelled —
 * only silenced. Its `.then` still runs and checks the generation before writing, so a slow answer
 * from before the invalidate can never overwrite what a later fetch (or the invalidate itself)
 * already settled on.
 */
const cache = new Map<string, { info: ProjectLaunchInfo | null; fetchedAt: number }>()
const inFlight = new Map<string, Promise<void>>()
const generation = new Map<string, number>()

/** How long `ensureProjectLaunchInfo` waits on the round trip before giving up on it — same bound
 *  as `permissionMode.ts`'s `CAPS_WAIT_MS`. A launch must never block on this. */
const ENSURE_WAIT_MS = 3000

function currentGeneration(projectId: string): number {
  return generation.get(projectId) ?? 0
}

/** The last-known answer, synchronously — null when nothing has been fetched yet (or the project
 *  was never warmed, or the fetch itself found no shared executable content to gate at all: a
 *  caller reading null must treat it as "no override behavior", i.e. fail open, exactly like an
 *  unknown project id answers over the wire). */
export function projectLaunchInfoNow(projectId: string): ProjectLaunchInfo | null {
  return cache.get(projectId)?.info ?? null
}

/**
 * Kick off (or join) the launch-info fetch for one project. Never rejects, and never takes longer
 * than `ENSURE_WAIT_MS` — on timeout the promise resolves with whatever is cached (possibly
 * nothing), and a late answer still lands in `cache` for the NEXT read. Memoized per project: a
 * second caller while one is already in flight joins the same promise rather than firing a second
 * request.
 */
export function ensureProjectLaunchInfo(projectId: string): Promise<void> {
  const existing = inFlight.get(projectId)
  if (existing) return existing

  const gen = currentGeneration(projectId)
  const fetch = Promise.resolve()
    .then(() => window.nodeTerminal.projectSettings.launchInfo(projectId))
    .then((info) => {
      // A bump since this fetch started means `invalidateProjectLaunchInfo` (and likely a fresher
      // `ensure`) ran while we were in flight — never let a stale answer land over it.
      if (currentGeneration(projectId) === gen) cache.set(projectId, { info, fetchedAt: Date.now() })
    })
    .catch(() => {
      // Fail open: leave whatever is cached (possibly nothing) alone.
    })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, ENSURE_WAIT_MS))
  const bounded = Promise.race([fetch, timeout])
  // Own in-flight entry cleared only by the request that owns it — an abandoned (invalidated)
  // fetch's `finally` must not delete a NEWER fetch's entry out from under it.
  fetch.finally(() => {
    if (inFlight.get(projectId) === bounded) inFlight.delete(projectId)
  })
  inFlight.set(projectId, bounded)
  return bounded
}

/** Drops the cached answer and abandons any in-flight fetch's write (see the module doc) — the
 *  next `projectLaunchInfoNow` reads null and the next `ensureProjectLaunchInfo` starts fresh.
 *  Called on `onTrustChanged` for the affected project, and after a settings-panel save. */
export function invalidateProjectLaunchInfo(projectId: string): void {
  cache.delete(projectId)
  generation.set(projectId, currentGeneration(projectId) + 1)
  inFlight.delete(projectId)
}

/** Test seam: drop every memo (cache, in-flight, generation counters). */
export function resetProjectLaunchInfoForTests(): void {
  cache.clear()
  inFlight.clear()
  generation.clear()
}
