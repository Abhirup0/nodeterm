/**
 * Stale working-directory detection for a WARM tmux reattach (issue #464).
 *
 * The failure this classifies: a project folder is deleted and re-created at the same path while
 * the node's tmux session keeps running. The shell inside still holds the DELETED directory's
 * inode — a fresh directory with the same name is a different inode, so nothing self-heals — and
 * every prompt prints `getcwd: cannot access parent directories`. `tmux new-session -A` reattaches
 * without looking at the cwd we pass, so the warm-attach path is the one that needs to notice.
 *
 * The signal is tmux's own `#{pane_current_path}` (present since tmux 1.7, so no version hazard —
 * see the bracket_paste_flag tombstone in pty-manager.ts for why that check matters):
 *
 * - **Linux (MEASURED, tmux 3.4):** tmux reads `/proc/<pid>/cwd`, and for an unlinked directory
 *   the kernel reports `<path> (deleted)` — including AFTER a same-named directory is re-created,
 *   because the readlink names the inode the process holds, not the path. This is the definite
 *   signal on Linux.
 * - **macOS (inferred from tmux source, NOT device-measured — see the PR's device checklist):**
 *   `osdep-darwin.c` resolves the cwd via `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, which cannot
 *   produce a path for an UNLINKED directory vnode; tmux then answers NULL and the format expands
 *   to an EMPTY string. So on darwin an empty answer for a live pane is read as stale. Kept
 *   darwin-only on purpose: on other platforms an empty answer more likely means "this platform's
 *   osdep has no cwd reader at all", and flagging every terminal there would be a wrong fact on
 *   screen (the house rule: degrade to nothing, never to something wrong).
 * - **Both platforms:** a non-empty path that no longer exists on disk is stale (deleted and not
 *   yet re-created).
 *
 * The verdict only ever raises a dismissible banner with an explicit user action (recycle +
 * respawn) — nothing is typed into the pane and nothing is killed without a click.
 */

export type PaneCwdVerdict = 'ok' | 'stale' | 'unknown'

/** The `/proc` readlink convention tmux passes through verbatim on Linux. */
const DELETED_SUFFIX = ' (deleted)'

/**
 * Classify a pane's live working directory from tmux's `#{pane_current_path}` answer.
 *
 * `reported` is the raw single-line answer (caller strips the trailing newline). `dirExists` is
 * injected so the pure rules are testable without a filesystem; it must answer "is this an
 * existing directory" and never throw.
 */
export function classifyPaneCwd(
  reported: string,
  dirExists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform
): PaneCwdVerdict {
  // Deliberately NOT trimmed: a path may legally end in spaces, and the one suffix we match is
  // exact. Only a trailing newline is the transport's, and the caller already removed it.
  if (reported === '') {
    // darwin: proc_pidinfo cannot name an unlinked cwd vnode → tmux answers empty (see module
    // docblock). Elsewhere empty is "tmux could not say", which is not evidence of anything.
    return platform === 'darwin' ? 'stale' : 'unknown'
  }
  if (reported.endsWith(DELETED_SUFFIX)) return 'stale'
  // Only judge an absolute path: anything else is not a directory answer at all.
  if (!reported.startsWith('/')) return 'unknown'
  // A path tmux still resolves cleanly but that is gone from disk: deleted, not yet re-created.
  // (The recreated-same-path case never lands here — on Linux it keeps the " (deleted)" suffix
  // above, and on darwin it comes in empty.)
  return dirExists(reported) ? 'ok' : 'stale'
}
