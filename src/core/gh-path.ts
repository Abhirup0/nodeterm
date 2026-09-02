import { findExecutableSync } from './exec-path'

const COMMON_GH_BIN_DIRS = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh'
]

/**
 * Resolves the path to the `gh` executable.
 *
 * Windows resolves a bare command against PATHEXT (`gh.EXE`, typically under
 * `C:\Program Files\GitHub CLI\`).
 * On macOS, GUI apps don't inherit the shell PATH, so the shared resolver checks
 * the login-shell PATH first, followed by well-known POSIX locations.
 *
 * MEMOIZED-ON-HIT rather than computed at import: a miss is re-probed so a gh
 * installed while the app is running is picked up, and the async login-shell PATH
 * probe that lands after module load is no longer raced.
 */
let cachedGh: string | null | undefined

export function ghPath(): string | null {
  if (cachedGh) return cachedGh
  const found = findExecutableSync('gh', COMMON_GH_BIN_DIRS)
  // Only a HIT is cached. Caching a miss here would freeze the answer for the process lifetime.
  if (found) cachedGh = found
  return found
}

/** Reset the cached path (for testing). */
export function _resetGhPathForTest(): void {
  cachedGh = undefined
}
