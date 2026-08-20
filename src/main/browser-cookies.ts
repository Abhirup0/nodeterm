/**
 * `--cookies <domain>` (PR 9 Task 9.3). Reading a site's cookies hands the raw session token to the
 * agent AS DATA — a string it can print to its transcript, write to a file, or paste into a curl — so
 * from that moment the session is portable and revoking it means logging out on the site, not closing
 * the node. The owner asked for this (agentic login needs it), so it is ALLOWED — but it MUST be
 * LOUDLY TRACED, and the trace is appended BEFORE the read, fail-closed: a cookie read that happened
 * but was not recorded is the one outcome this module exists to prevent.
 *
 * USING a session is not READING one, and that distinction is why one is silent and the other loud.
 * A --nav to a logged-in site sends the jar's cookies automatically and renders the page logged in —
 * the agent gets the BENEFIT without the token ever being handed to it, and none of the five core
 * actions touches a cookie API. `Network.getCookies` hands the raw token over; `Network.getAllCookies`
 * (the jar-emptying call that names no domain and so informs nobody) is not in the allowlist at all,
 * and this module only ever issues `getCookies` with an explicit, single-domain URL list.
 *
 * Three limits on this trace, none of them a reason not to have it:
 *  1. NOT TAMPER-PROOF. board-log.jsonl is a file in a project the agent usually has write access to.
 *     This is an audit trail against an agent that is not hiding — the realistic case for a
 *     prompt-injected agent following instructions it believes are legitimate — not forensics.
 *  2. NOT THE ONLY WAY. An agent with shell access can read Chromium's cookie DB out of the user data
 *     dir with no CDP and no trace. This covers THIS PATH, not cookies in general.
 *  3. IT MAY BE COMMITTED. .nodeterm/ is gitignored in nodeterm's own repo, but nothing guarantees
 *     that in a user's project — project.json in the same directory is expected to be committed. A
 *     line naming a domain is mild, but it is a domain the user visited, in a commit.
 *
 * Main-side only (it holds a debugger on a page with real logins); never Server Edition.
 */
import { currentUrl, type Sendable, type ActionResult } from './browser-actions'

/** The parser already refuses an empty domain; kept here so the message never drifts between them. */
export const COOKIES_NO_DOMAIN =
  'browser: --cookies takes one domain (use "current" for the page\'s own)'

/** Fail-closed: the trace could not be durably written, so the read is refused. Naming the cause
 *  (no reachable activity log) tells the agent this is not a permissions verdict on cookies. */
export const COOKIES_NOT_RECORDED =
  "browser: the cookie read could not be recorded in the project's activity log, so it did not happen"

/** `--cookies current` on a page with no resolvable http(s) origin (about:blank, a data: URL). */
export const COOKIES_NO_CURRENT_DOMAIN =
  "browser: --cookies current needs a page on an http(s) site (this one has no domain)"

/** The whole trace side of the read, injected so the ordering (trace BEFORE read, fail-closed) is
 *  unit-testable without a board log. `recordTrace` returns false when there is no reachable log OR
 *  the write failed — both mean "not recorded". */
export interface CookieReadDeps {
  recordTrace(domain: string): Promise<boolean>
}

/** A plain host (optionally with a port). The domain is DATA, so a value that is not a host — a URL,
 *  a path, whitespace, a newline that would smuggle a second board-log field — is refused, never
 *  interpolated into a URL or a trace line. */
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:\d+)?$/

function hostFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.host || null
  } catch {
    return null
  }
}

/**
 * Read the cookies for one domain, LOUDLY. Resolve the target host (an explicit domain, or the page's
 * own for `current`), append the trace FIRST — and only if that trace was durably recorded, issue the
 * single-domain `Network.getCookies`. The reply tells the agent it was recorded, so an agent that
 * prints that line into its transcript has told the user too.
 */
export async function browserCookies(
  s: Sendable,
  nodeId: string,
  domain: string,
  deps: CookieReadDeps
): Promise<ActionResult> {
  if (!domain) return { ok: false, message: COOKIES_NO_DOMAIN }

  let host: string
  if (domain === 'current') {
    const h = hostFromUrl(await currentUrl(s))
    if (!h) return { ok: false, message: COOKIES_NO_CURRENT_DOMAIN }
    host = h
  } else {
    if (!HOST_RE.test(domain)) {
      return { ok: false, message: `browser: --cookies domain "${domain}" is not a valid host` }
    }
    host = domain
  }

  // TRACE BEFORE READ, fail-closed. An exception from the appender is the same fact as `false`.
  let recorded = false
  try {
    recorded = await deps.recordTrace(host)
  } catch {
    recorded = false
  }
  if (!recorded) return { ok: false, message: COOKIES_NOT_RECORDED }

  // A single, domain-naming read — never the jar-emptying getAllCookies. Both schemes so an
  // http-only cookie on a plain-http site is not silently missed.
  const res = (await s.send('Network.getCookies', {
    urls: [`https://${host}/`, `http://${host}/`]
  })) as { cookies?: unknown }
  const cookies = Array.isArray(res?.cookies) ? res.cookies : []
  const n = cookies.length
  const plural = n === 1 ? 'cookie' : 'cookies'
  return {
    ok: true,
    message: `read ${n} ${plural} for ${host} — this was recorded in the project's activity log.`
  }
}
