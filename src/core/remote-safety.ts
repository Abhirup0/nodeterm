/**
 * Predicates for values that cross into a REMOTE SHELL.
 *
 * Both of these guard the same class of bug: a string that arrived as DATA (a node id read out of
 * `.nodeterm/project.json`, a `$HOME` a host printed back at us) ends up inside a command line the
 * remote user's shell parses. Quoting at the splice site is the primary defence — see
 * `remoteTmuxPtyArgs` and `RemoteHooks.setup` — and these are the second layer, applied where the
 * value ENTERS the system so a future splice that forgets to quote is not instantly exploitable.
 *
 * No node/electron imports: usable from core, main, and the server shell alike.
 */

/** Generous cap on a node id — longer than anything the app mints, short enough to bound. */
export const NODE_ID_MAX = 128
/** Generous cap on a host-reported `$HOME`; longer than any real path (PATH_MAX on Linux). */
export const REMOTE_HOME_MAX = 4096

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

/**
 * Is a remote host's answer to `printf %s "$HOME"` usable for building remote paths?
 *
 * The host's answer is data, not truth. Only an absolute POSIX path with no backslash and no
 * control character is usable — a newline in particular is a COMMAND SEPARATOR on the remote
 * command lines the caller then builds. Spaces and non-ASCII are permitted: `/Users/Enes Kırca` is
 * a real home, and rejecting it would disable hooks for that user; the caller quotes the value, so
 * a space is a quoting problem, not a safety one.
 *
 * Like `isSafeRemoteGrokHome` (which delegates here) it judges the EXACT string the caller holds —
 * surrounding whitespace is a rejection, not something this quietly strips. Trimming here would
 * return `true` about a value whose embedded `\n` the caller is about to interpolate. Remote reads
 * trim at the READ site instead.
 */
export function isSafeRemoteHome(p: string | undefined | null): boolean {
  const v = p?.trim()
  if (!v || v !== p) return false
  if (!v.startsWith('/') || v.includes('\\') || v.length > REMOTE_HOME_MAX) return false
  return !Array.from(v).some((ch) => {
    const c = ch.charCodeAt(0)
    return c <= 0x1f || c === 0x7f
  })
}
