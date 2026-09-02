/**
 * Turning a node's icon IMAGE into something an `<img>` can show, once per file rather than once
 * per place it is drawn.
 *
 * The same icon appears on the canvas node header, on its kanban card, in the card modal and in
 * the sessions sidebar — four components that mount and unmount independently. Read per component
 * and a board of thirty sessions issues thirty duplicate `readBinary` round trips on every open,
 * for bytes that have not changed. So the promise is cached by absolute path and every caller
 * awaits the same one.
 *
 * Caching by PATH is safe because a picked image is never overwritten in place: `saveCanvasImage`
 * creates exclusively (`wx`) and walks `candidateName`, so re-picking produces `logo (2).png`, a
 * different key. An icon the user points at an arbitrary file they later edit is the one case a
 * stale entry could survive, and it costs an app restart — the trade a per-render re-read is not
 * worth.
 *
 * Reads go through the PROJECT's own session api, not `window.nodeTerminal`: a relay tab's project
 * lives on a peer's core, and its `./`-relative icon resolves against the peer's cwd. Reading it
 * locally would ask this machine for a path only that one has.
 */
import { useEffect, useState } from 'react'
import type { FsApi } from '@shared/types'
import { localIconCwd, type NodeIcon, nodeIconMime, resolveIconPath } from '@shared/node-icon'
import { sessionForProject } from '../session/session'
import { useProjects } from '../state/projects'

/**
 * Bounded so a long session that visits many projects cannot grow it without limit. Icons are
 * small and few per canvas; 128 is far above any real board and still a fixed ceiling.
 */
const CACHE_MAX = 128

/**
 * An icon big enough to be worth refusing. `readBinary` already returns a sentinel STRING above
 * its own cap rather than base64, and that sentinel is not valid base64 — an `<img>` fed it shows
 * a broken-image glyph on every surface, which is worse than no icon. This bound catches both
 * that case and a merely huge file, and its unit is base64 characters (~3/4 of a byte each).
 */
const SRC_MAX_CHARS = 4_000_000

const cache = new Map<string, Promise<string | null>>()

/** The cache key includes the reader: two projects can resolve the same `./` path against
 *  different roots, and a relay project's read lands on another machine entirely. */
const keyFor = (projectId: string, absPath: string): string => `${projectId}\x00${absPath}`

/** Test seam, and the escape hatch for "I replaced the file on disk". */
export function clearNodeIconCache(): void {
  cache.clear()
}

/**
 * Read `absPath` as a data URL, or null when it could not be read. Never rejects: an icon that
 * cannot be drawn falls back to no icon, which is the pre-feature node.
 */
export function loadNodeIconSrc(
  fs: FsApi,
  projectId: string,
  absPath: string
): Promise<string | null> {
  const key = keyFor(projectId, absPath)
  const hit = cache.get(key)
  if (hit) return hit
  const mime = nodeIconMime(absPath)
  // Unreachable through `normalizeNodeIcon` (which already refuses a non-image extension), and
  // deliberately still checked: this function is exported and the next caller may not have gone
  // through it.
  if (!mime) return Promise.resolve(null)
  const pending = Promise.resolve()
    .then(() => fs.readBinary(absPath))
    .then((b64) => (b64 && b64.length < SRC_MAX_CHARS ? `data:${mime};base64,${b64}` : null))
    .catch(() => null)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, pending)
  return pending
}

/**
 * The `src` for an icon image, or null while it loads / when it cannot be read. `projectId`
 * defaults to the active project — pass it explicitly from any surface that lists nodes across
 * projects (the sessions sidebar's status mode does), or the icon resolves against the wrong root.
 */
export function useNodeIconSrc(icon: NodeIcon | undefined, projectId?: string): string | null {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const pid = projectId ?? activeProjectId
  const storedPath = icon?.type === 'image' ? icon.path : null
  // `localIconCwd`, not `project.cwd` — the single definition of "which cwd may a `./` icon be
  // resolved against", shared with the picker's write side so the two cannot drift again. Selected
  // down to ONE primitive here on purpose: the project object is rebuilt on every node
  // serialization, so returning it would re-run this effect on every canvas edit.
  const cwd = useProjects((s) => (pid ? localIconCwd(s.getProject(pid)) : undefined))
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!storedPath || !pid) {
      setSrc(null)
      return
    }
    const abs = resolveIconPath(storedPath, cwd)
    if (!abs) {
      // A `./` icon on a project with no local cwd: the file belongs to a checkout this machine
      // does not have. Nothing to read, and nothing worth guessing at.
      setSrc(null)
      return
    }
    let live = true
    void loadNodeIconSrc(sessionForProject(pid).api.fs, pid, abs).then((v) => {
      if (live) setSrc(v)
    })
    return () => {
      live = false
    }
  }, [storedPath, pid, cwd])

  return src
}
