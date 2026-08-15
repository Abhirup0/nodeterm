/**
 * THE node-id predicate, in `src/shared` because both sides of the process boundary need the SAME
 * one: core/main validate an id before it crosses into a remote shell or a filesystem path, and the
 * renderer must validate a project id before it becomes a session-partition storage key
 * (`persist:nt-agent-browser-<projectId>`) — and the renderer may not import `src/core`.
 *
 * Moved here from `core/remote-safety.ts`, which re-exports it so every existing import path is
 * untouched; `safe-id.test.ts` pins that the two names are one function object. No imports at all:
 * usable from core, main, renderer and the server shell alike.
 */

/** Generous cap on a node id — longer than anything the app mints, short enough to bound. */
export const NODE_ID_MAX = 128

/**
 * Is this a node id (a `persistKey`) safe to carry into a remote command line and a filesystem
 * path?
 *
 * Charset is deliberately narrower than "no metacharacters": `[A-Za-z0-9._-]` covers every id the
 * app actually produces — `nextId()` emits `<prefix>-<base36 time>-<counter>` and `uuid()` emits
 * hex-with-dashes — so the answer to "could this refuse something legitimate?" is a list, not a
 * guess. `.` and `..` are refused on top of the charset: they pass it but name a directory, and
 * these ids are also used as path components (session files, per-node remote state). It is also
 * the charset the codex identity shim ALREADY enforces on `$NODETERM_NODE_ID` before it will use
 * it (`codex-identity-proxy.ts`: `*[!A-Za-z0-9._-]*) nt_fail node-id-unavailable`), so this is the
 * existing rule moved to the boundary rather than a new one invented here.
 *
 * An EMPTY id is refused here and must be handled by the caller as "not persistent" rather than as
 * a violation — `PtyManager.create` already branches on a falsy `persistKey` before it asks.
 */
export function isSafeNodeId(id: string | undefined | null): boolean {
  if (!id || id.length > NODE_ID_MAX) return false
  if (id === '.' || id === '..') return false
  return /^[A-Za-z0-9._-]+$/.test(id)
}
