// Locating a REMOTE (SSH-project) Claude transcript when no live hook event has fed one.
//
// `remoteTranscriptBySession` (src/main) is filled ONLY by hook POSTs, and a tmux session
// outlives the app — so after an app restart an idle remote agent node has no ref at all, and
// the local resolvers then search THIS machine's disk for a session that exists only on the
// host. That is the "⌘M says there is no conversation" case: it healed itself the moment the
// user sent one prompt (the next hook event registered the ref), which is exactly what made it
// look intermittent.
//
// These are pure string builders. `src/main` runs the command over the project's ControlMaster
// and jails the answer with `isSafeRemoteTranscriptPath` before reading it.
import { posixQuote } from '../shared/ssh'
import { SESSION_ID_RE, encodeTranscriptDir } from './transcript-reader'

/**
 * Transcript roots to search on the host: the node's managed-account root first (that is where
 * its session actually lives when it runs under one), then the system `~/.claude/projects`.
 * Both are kept because a node's persisted `accountId` and the dir its CLI actually used can
 * disagree (an account removed since, a session started before the account was assigned) — and
 * every root here is inside what `isSafeRemoteTranscriptPath` already admits.
 */
export function remoteTranscriptRoots(remoteHome: string, accountConfigDir?: string): string[] {
  const home = remoteHome.replace(/\/+$/, '')
  const roots: string[] = []
  if (accountConfigDir) roots.push(`${accountConfigDir.replace(/\/+$/, '')}/projects`)
  roots.push(`${home}/.claude/projects`)
  return roots
}

/**
 * One POSIX `sh` line that prints the first existing transcript for `sessionId`, or nothing.
 *
 * Ordered by cost: the exact `<root>/<encoded cwd>/<id>.jsonl` first (one stat per root), then a
 * glob across every project dir — the session's cwd can differ from the node's (the user `cd`ed,
 * or the node was created elsewhere), and without the glob those resolve to nothing at all.
 *
 * The `*` is deliberately left OUTSIDE the quotes: quoting the whole pattern would make sh look
 * for a literal star. Everything interpolated is app-built (the roots) or validated (`sessionId`
 * against `SESSION_ID_RE`, which admits no '/' or '.'), so nothing here can escape the roots.
 * Returns null for an unusable session id rather than emitting a command that cannot match.
 */
export function locateRemoteTranscriptCommand(
  roots: string[],
  cwd: string | undefined,
  sessionId: string
): string | null {
  if (!roots.length || !SESSION_ID_RE.test(sessionId)) return null
  const leaf = posixQuote(`${sessionId}.jsonl`)
  const candidates: string[] = []
  if (cwd) {
    const dir = encodeTranscriptDir(cwd)
    for (const r of roots) candidates.push(posixQuote(`${r}/${dir}/${sessionId}.jsonl`))
  }
  for (const r of roots) candidates.push(`${posixQuote(r)}/*/${leaf}`)
  // A glob that matches nothing stays literal in sh, so `[ -f ]` simply rejects it. The trailing
  // `:` keeps the exit status 0 on a clean miss: the loop's last command would otherwise be the
  // failed `[ -f ]`, and "no transcript for this session" is an ANSWER, not a failed ssh call.
  return `for f in ${candidates.join(' ')}; do [ -f "$f" ] && { printf '%s\\n' "$f"; break; }; done; :`
}

/** First non-empty line of the locator's stdout — the resolved path, or undefined. */
export function parseLocatedTranscript(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (s) return s
  }
  return undefined
}
