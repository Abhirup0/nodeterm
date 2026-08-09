// Pure path algebra for grok's config + session layout. No `fs` and no `electron`, so `src/main`,
// `src/core`, `src/server` and the SSH installer all share ONE definition — the drift between two
// copies of a path rule is exactly what made the remote hook installer subscribe gemini to
// claude's event names for months.
//
// NODE-SIDE shared code: it imports `path`/`os` and uses `Buffer`, so it is for `src/main`,
// `src/core`, `src/server` and the SSH installer only — it has no renderer consumer today. A
// renderer surface that needs one of these helpers must first split the pure half out (the
// encoding/validation functions are pure; `grokHomeDir`/`grokSessionsDir` are not, they read
// `homedir()`), not import this file into the browser bundle.
//
// Measured layout (shipped 1.0.0):
//   $GROK_HOME/hooks/*.json                     — hook files, all merged; GROK_HOME defaults to ~/.grok
//   $GROK_HOME/sessions/<encoded cwd>/<id>/     — one directory per session, grouped by cwd
//     summary.json  updates.jsonl  chat_history.jsonl  signals.json  plan.json  subagents/
import path from 'path'
import { homedir } from 'os'

export const GROK_HOOK_FILE = 'nodeterm-status.json'
export const GROK_SUMMARY_FILE = 'summary.json'
export const GROK_SIGNALS_FILE = 'signals.json'
export const GROK_UPDATES_FILE = 'updates.jsonl'
export const GROK_CHAT_HISTORY_FILE = 'chat_history.jsonl'

/** grok URL-encodes the cwd to name a session group; past this many BYTES it switches to a
 *  slug+hash directory instead, which we cannot reconstruct — so we resolve nothing there. */
export const GROK_ENCODED_CWD_MAX_BYTES = 255
const GROK_SESSION_ID_MAX = 128
/** Generous cap on a host-reported $GROK_HOME; longer than any real path, short enough to bound. */
const REMOTE_HOME_MAX = 4096

// The index signature is what lets `process.env` (NodeJS.ProcessEnv, i.e. Dict<string>) be the
// default argument: without it GrokEnv is a WEAK type — all-optional — and TS rejects a source
// whose declared properties do not overlap, index signature or not (TS2559).
type GrokEnv = { GROK_HOME?: string | undefined; [k: string]: string | undefined }

/** grok's config directory: `$GROK_HOME`, else `~/.grok`. Hooks AND sessions live under it. */
export function grokHomeDir(env: GrokEnv = process.env, home: string = homedir()): string {
  const fromEnv = env.GROK_HOME?.trim()
  return fromEnv || path.join(home, '.grok')
}

export function grokSessionsDir(env: GrokEnv = process.env, home: string = homedir()): string {
  return path.join(grokHomeDir(env, home), 'sessions')
}

/** The session-group directory name for a cwd, or null when grok would not have used this scheme. */
export function grokEncodedCwdDirName(cwd: string): string | null {
  const trimmed = cwd.trim()
  if (!trimmed) return null
  let encoded: string
  try {
    encoded = encodeURIComponent(trimmed)
  } catch {
    return null
  }
  // encodeURIComponent deliberately leaves dots untouched — reject path syntax explicitly.
  if (encoded === '.' || encoded === '..' || encoded.includes('/') || encoded.includes('\\')) return null
  return Buffer.byteLength(encoded, 'utf8') <= GROK_ENCODED_CWD_MAX_BYTES ? encoded : null
}

/** grok's ids are UUIDs; the charset is enforced because this value reaches both a path and (via
 *  `grok --resume <id>`) a shell command line. */
export function isSafeGrokSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= GROK_SESSION_ID_MAX && /^[A-Za-z0-9_-]+$/.test(sessionId)
}

/** The session directory for (cwd, sessionId) — both of which every grok hook payload carries, so
 *  nothing has to scan. Null when either half is unusable: a half-resolved path must never leak. */
export function grokSessionDir(a: { sessionsDir: string; cwd: string; sessionId: string }): string | null {
  const encoded = grokEncodedCwdDirName(a.cwd)
  const id = a.sessionId.trim()
  if (!encoded || !isSafeGrokSessionId(id)) return null
  return path.join(a.sessionsDir, encoded, id)
}

/** Validate a $GROK_HOME reported by a REMOTE host before it is used to build remote paths. The
 *  host's answer is data, not truth: only an absolute POSIX path with no backslash or control
 *  character is usable, and the caller falls back to `$HOME/.grok`. */
export function isSafeRemoteGrokHome(p: string | undefined): boolean {
  const v = p?.trim()
  if (!v) return false
  if (!v.startsWith('/') || v.includes('\\') || v.length > REMOTE_HOME_MAX) return false
  return !Array.from(v).some((ch) => {
    const c = ch.charCodeAt(0)
    return c <= 0x1f || c === 0x7f
  })
}
