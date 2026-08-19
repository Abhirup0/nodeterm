import { create } from 'zustand'
import type { ProjectLaunchInfo } from '@shared/project-settings'
import type { ProjectVisualOverrides } from '../terminal/terminal-config'

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
 * another's warm entry. `generation` is claimed FRESH by every fetch this module actually issues
 * (not merely bumped by `invalidate`): a write is honored only while its own claimed value is still
 * the current one. This closes two distinct ways an abandoned fetch can otherwise clobber a fresher
 * answer:
 *  - `invalidateProjectLaunchInfo` bumps it directly and drops the in-flight entry, so an in-flight
 *    fetch that predates the invalidate is superseded even if nothing ever re-`ensure`s.
 *  - the ENSURE_WAIT_MS timeout (below) drops the in-flight entry WITHOUT touching the generation —
 *    on its own, a fetch that never settles (a dropped Server Edition WS-RPC request neither times
 *    out nor rejects — see permissionMode.ts's `CAPS_WAIT_MS` doc) would otherwise leave `inFlight`
 *    pointing at an exhausted promise forever, so every later `ensure` for that project just
 *    rejoins it and NO fresh wire call is ever made again. Dropping the entry lets the next `ensure`
 *    issue a real new fetch, which claims its OWN generation — so if the original fetch finally
 *    answers after that, its stale generation no longer matches and its write is silently dropped,
 *    exactly like the invalidate case.
 * Neither path cancels the abandoned fetch (there is nothing to cancel it with) — only its write is
 * ever silenced, never the promise itself.
 */
const cache = new Map<string, { info: ProjectLaunchInfo | null; fetchedAt: number }>()
const inFlight = new Map<string, Promise<void>>()
const generation = new Map<string, number>()

/** How long `ensureProjectLaunchInfo` waits on the round trip before giving up on it — same bound
 *  as `permissionMode.ts`'s `CAPS_WAIT_MS`. A launch must never block on this. */
const ENSURE_WAIT_MS = 3000

/**
 * The REACTIVE mirror of the cache above — and only of the two cosmetic terminal values
 * (`terminal.theme` / `terminal.fontFamily`), never of the trust verdict.
 *
 * The cache is deliberately not a store: a launch READS it at the moment it launches, so nothing
 * needs to re-render when it changes. Live terminal appearance is the one consumer that does — a
 * project's theme has to reach terminals that are already on screen — and a module-level `Map` can
 * never notify them. Rather than turn the whole cache into a store (which would re-render every
 * terminal on the canvas whenever an unrelated launch field or trust bit moved), this carries the
 * appearance slice alone, so `useXtermVisualSettings` can subscribe shallowly to exactly what it
 * renders.
 *
 * Kept in lockstep with `cache` — written by the same generation-guarded branch, cleared by
 * `invalidate` — so the mirror never claims a value the cache has already dropped. Clearing on
 * invalidate does mean the panel's save path (`invalidate` then re-`ensure`) shows this machine's
 * GLOBAL appearance for the length of one round trip before the project's own comes back. That is
 * accepted deliberately: the alternative — holding the last-known value across an invalidate — keeps
 * a project's colours on screen indefinitely whenever the re-read fails, and a theme that cannot be
 * explained by any document on disk is a worse bug than a repaint the user sees correct itself.
 */
interface ProjectVisualsState {
  byProject: Record<string, ProjectVisualOverrides>
}
export const useProjectVisuals = create<ProjectVisualsState>(() => ({ byProject: {} }))

function sameVisuals(a: ProjectVisualOverrides | undefined, b: ProjectVisualOverrides): boolean {
  return a !== undefined && a.theme === b.theme && a.fontFamily === b.fontFamily
}

/** Push one project's appearance slice into the mirror. No-ops when nothing changed, INCLUDING the
 *  object identity — a re-ensure that answers the same values must not re-render a canvas full of
 *  terminals (the subscription is shallow, but the entry itself is what it compares). */
function syncVisuals(projectId: string, info: ProjectLaunchInfo | null): void {
  const terminal = info?.resolved.terminal
  const next: ProjectVisualOverrides = {
    theme: terminal?.theme?.value,
    fontFamily: terminal?.fontFamily?.value
  }
  useProjectVisuals.setState((s) => {
    if (sameVisuals(s.byProject[projectId], next)) return s
    return { byProject: { ...s.byProject, [projectId]: next } }
  })
}

/** Drop one project's mirrored appearance — its terminals fall back to the global settings until a
 *  fresh answer lands. */
function clearVisuals(projectId: string): void {
  useProjectVisuals.setState((s) => {
    if (!(projectId in s.byProject)) return s
    const { [projectId]: _dropped, ...rest } = s.byProject
    return { byProject: rest }
  })
}

function currentGeneration(projectId: string): number {
  return generation.get(projectId) ?? 0
}

/** Claims and returns a generation strictly newer than whatever the project is currently at —
 *  called once per fetch actually issued (never on a joined in-flight call), so two fetches for the
 *  same project always hold distinguishable values regardless of which one (invalidate, timeout, or
 *  a plain re-ensure) triggered the reissue. */
function claimGeneration(projectId: string): number {
  const next = currentGeneration(projectId) + 1
  generation.set(projectId, next)
  return next
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
 * nothing), and a late answer still lands in `cache` for the NEXT read PROVIDED nothing fresher
 * has claimed the project's generation since (see the module doc). Memoized per project: a second
 * caller while one is already in flight joins the same promise rather than firing a second request;
 * once a fetch's own in-flight entry is cleared (settled, or timed out), the NEXT caller always
 * issues a brand new wire call — a project is never left permanently cold by one dropped request.
 */
export function ensureProjectLaunchInfo(projectId: string): Promise<void> {
  const existing = inFlight.get(projectId)
  if (existing) return existing

  const gen = claimGeneration(projectId)
  const fetch = Promise.resolve()
    .then(() => window.nodeTerminal.projectSettings.launchInfo(projectId))
    .then((info) => {
      // A newer claim since this fetch started means it was superseded (an invalidate, or this
      // very fetch having already been abandoned by a timeout and reissued) — never let a stale
      // answer land over whatever a fresher fetch already wrote.
      if (currentGeneration(projectId) !== gen) return
      cache.set(projectId, { info, fetchedAt: Date.now() })
      // Same branch, same guard: the reactive mirror only ever reflects what the cache accepted.
      syncVisuals(projectId, info)
    })
    .catch(() => {
      // Fail open: leave whatever is cached (possibly nothing) alone.
    })

  // `bounded` is referenced inside the timeout callback before its own declaration below — safe
  // because the callback only runs asynchronously, well after `bounded` is assigned.
  let bounded!: Promise<void>
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      // The wire call may simply never answer (see the module doc). Clear OUR OWN in-flight entry
      // — guarded on identity, since a fetch that already finished (and cleared itself in the
      // `finally` below) may have already been superseded by a newer `ensure` by the time this
      // timer fires, and that newer entry must not be touched.
      if (inFlight.get(projectId) === bounded) inFlight.delete(projectId)
      resolve()
    }, ENSURE_WAIT_MS)
  })
  bounded = Promise.race([fetch, timeout])
  // Same identity guard as the timeout branch: a fetch that answers after ITS OWN timeout already
  // cleared (and possibly a newer fetch is now in flight) must not delete that newer entry.
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
  clearVisuals(projectId)
  generation.set(projectId, currentGeneration(projectId) + 1)
  inFlight.delete(projectId)
}

/** Test seam: drop every memo (cache, in-flight, generation counters). */
export function resetProjectLaunchInfoForTests(): void {
  cache.clear()
  inFlight.clear()
  generation.clear()
  useProjectVisuals.setState({ byProject: {} })
}
