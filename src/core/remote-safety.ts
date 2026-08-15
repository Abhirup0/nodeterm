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

// `isSafeNodeId` / `NODE_ID_MAX` MOVED to `@shared/safe-id` (re-exported here so no existing
// import path changes): the renderer needs this exact predicate to validate a project id before it
// becomes a session-partition storage key, and the renderer may not import `src/core`. One
// predicate, two consumers — `remote-safety.test.ts` pins that this name and the shared one are
// the same function object, so the two cannot drift.
export { NODE_ID_MAX, isSafeNodeId } from '../shared/safe-id'

/** Generous cap on a host-reported `$HOME`; longer than any real path (PATH_MAX on Linux). */
export const REMOTE_HOME_MAX = 4096

/**
 * Every character that is live shell syntax at a `$HOME` interpolation site, plus every control
 * character. It is a DENYLIST on purpose — see `isSafeRemoteHome`.
 *
 *  - C0 (u0000-u001f) and C1 (u007f-u009f) controls: \n / \r are command separators, \t is IFS,
 *    NUL truncates. U+2028/U+2029 are not shell-special but are line breaks everywhere else
 *    (logs, JSON) and no real path holds one.
 *  - Expansion characters: `$` and backtick. `$(…)` and backticks are command substitution, and
 *    `$'` in particular was a live RCE vector through a JS string-replacement splice (see
 *    `remoteTmuxPtyArgs`) even with the value correctly `posixQuote`d.
 *  - `\\` — an escape at every double-quoted site.
 *  - `"` — closes a double-quoted interpolation.
 *  - `;&|<>(){}` — separators, pipes, redirections, subshells, brace expansion.
 *  - `*?[]` — globs; a star in the path makes `mkdir -p` reach a directory we never named.
 *  - `!#` — history expansion and comments.
 *
 * The class is written with \u ESCAPES, never raw bytes: a source file carrying a literal NUL is
 * skipped in silence by git, grep and ripgrep (this repo has lost two files to that).
 *
 * NOT here, deliberately:
 *  - every letter on earth. That was the bug (see below).
 *  - the SINGLE QUOTE. `/home/o'brien` is somebody's actual home, `posixQuote` round-trips it
 *    byte-for-byte through /bin/sh (`'o'\''brien'`), and every site this value reaches is quoted.
 *    Refusing it would be a silent total outage for that user in exchange for nothing.
 */
const REMOTE_HOME_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029"`$\\;&|<>(){}[\]*?!#]/

/**
 * Is a remote host's answer to `printf %s "$HOME"` usable for building remote paths?
 *
 * The host's answer is DATA, not truth — a host can set `$HOME` to whatever it likes, and this
 * value is interpolated into remote command lines run as the SSH user. Quoting at the splice is the
 * primary defence (every site now quotes); this is the second layer, so a future splice that
 * forgets is not instantly exploitable.
 *
 * THE SHAPE MATTERS. This used to be an allowlist — `/^[\w./ -]+$/` — and `\w` in JavaScript is
 * `[A-Za-z0-9_]`, always, with or without the `u` flag; there is no switch that widens it. So
 * `/home/josé`, `/home/gökhan`, `/Users/山田` and every other home whose owner does not spell their
 * name in ASCII was judged "not a plain path", and the consequence was total and silent for those
 * users: no status badges, no context meter, no subagent cards, on every SSH host they own. An
 * allowlist of LETTERS can only ever be a list of the alphabets its author thought of.
 *
 * So it enumerates what is DANGEROUS instead (`REMOTE_HOME_UNSAFE`), which is a closed set. Anything
 * else — any script's letters, spaces (`/Users/First Last` is ordinary on macOS), dots, dashes,
 * underscores, `+`, apostrophes — is just a path.
 *
 * It must also be ABSOLUTE: a relative answer would build relative remote paths against whatever
 * cwd the exec channel lands in, and `../..` stops being interesting the moment `/` is required up
 * front.
 *
 * Like `isSafeRemoteGrokHome` (which delegates here) it judges the EXACT string the caller holds —
 * surrounding whitespace is a rejection, not something this quietly strips. Trimming here would
 * return `true` about a value whose embedded `\n` the caller is about to interpolate. Remote reads
 * trim at the READ site instead.
 */
export function isSafeRemoteHome(p: string | undefined | null): boolean {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= REMOTE_HOME_MAX &&
    p.startsWith('/') &&
    p === p.trim() &&
    !REMOTE_HOME_UNSAFE.test(p)
  )
}
