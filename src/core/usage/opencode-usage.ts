// opencode usage, scraped from opencode.ai's dashboard HTML.
//
// ⚠️ This is the least robust provider here, and knowingly so. opencode publishes no usage API,
// so the numbers are dug out of React Flight wire data embedded in a page we do not control.
// There are three independent things that can break it, none of which fail at compile time:
//
//   1. WORKSPACES_SERVER_ID below is a hash of opencode.ai's own server function. It changes
//      when they redeploy. That is why a workspace id can be supplied by the user as an
//      override — discovery breaking should not take the whole provider down with it.
//   2. The wire format is a framework implementation detail (`key:$R[28]={...}`), not a
//      contract.
//   3. The block parser tracks brace depth and does NOT skip string literals, so a `{` inside a
//      string in future output would desynchronize it.
//
// The design rule that follows: when a cookie IS configured but nothing parses, this reports
// 'error', never an empty 'ok'. A broken scraper must look broken. Silently reporting "no
// usage" would be indistinguishable from "not signed in" and would quietly mislead — which is
// exactly the failure mode that got the CLI screen-scraping tier rejected.
import type { ProviderUsage, UsageLimit } from '../../shared/types'

const BASE_URL = 'https://opencode.ai'
const SERVER_URL = `${BASE_URL}/_server`
const FETCH_TIMEOUT_MS = 15_000

/** Server-function hash for the workspaces endpoint. A deployment artifact — see header. */
const WORKSPACES_SERVER_ID =
  'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

/** Only these carry session auth on opencode.ai. Sending the rest would leak unrelated cookies. */
const AUTH_COOKIE_NAMES = new Set(['auth', '__Host-auth'])

const WORKSPACE_ID_RE = /^(?:wrk|wk)_[A-Za-z0-9]+$/

const ROLLING_WINDOW_MINUTES = 300 // 5h
const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200

/**
 * Users paste either the whole `Cookie:` header or just the bare token value. A bare token is
 * wrapped rather than rejected — otherwise the cookie looks non-empty, carries no recognized
 * name, and fails with a confusing 401.
 */
export function normalizeCookieInput(raw: string): string {
  const trimmed = raw.trim().replace(/^Cookie:\s*/i, '')
  if (!trimmed) return ''
  if (trimmed.includes(';') || /^(?:auth|__Host-auth)=/i.test(trimmed)) return trimmed
  // A bare value with no `=` at all is a token; anything else is left alone so it fails
  // predictably instead of being silently mangled into malformed auth.
  return trimmed.includes('=') ? trimmed : `auth=${trimmed}`
}

/** Keep only the auth cookies, so unrelated site cookies are never transmitted. */
export function filterAuthCookie(cookie: string): string | null {
  const kept: string[] = []
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (AUTH_COOKIE_NAMES.has(name)) kept.push(`${name}=${part.slice(eq + 1).trim()}`)
  }
  return kept.length > 0 ? kept.join('; ') : null
}

/**
 * The balanced `{...}` block assigned to `key`, skipping React Flight's `$R[N]=` reference
 * tokens between the colon and the brace.
 *
 * A key can appear several times — once with real data and once as `null` inside another
 * component's props — so this keeps scanning until it finds a block carrying BOTH
 * `usagePercent` and `resetInSec` as direct (depth-1) numeric fields. Matching on the key alone
 * would happily return a billing-context object that merely shares the name.
 */
export function extractUsageBlock(text: string, key: string): string | null {
  const keyRegex = new RegExp(`\\b${key}\\b\\s*:`, 'g')
  let match: RegExpExecArray | null

  while ((match = keyRegex.exec(text)) !== null) {
    const from = match.index + match[0].length
    // Short window only, so a `{` belonging to the NEXT occurrence is never picked up.
    const braceOffset = text.slice(from, from + 30).indexOf('{')
    if (braceOffset === -1) continue // e.g. `monthlyUsage:null`

    const open = from + braceOffset
    let depth = 0
    let block: string | null = null
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          block = text.slice(open, i + 1)
          break
        }
      }
    }
    if (!block) continue

    if (topLevelNumber(block, 'usagePercent') !== null && topLevelNumber(block, 'resetInSec') !== null) {
      return block
    }
  }
  return null
}

/**
 * A numeric field at depth 1 of `objText`. Depth matters: without it, the first textual match
 * wins regardless of nesting, so a sub-object sharing the field name returns the wrong number.
 */
export function topLevelNumber(objText: string, field: string): number | null {
  const re = new RegExp(`^\\b${field}\\b\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`)
  let depth = 0
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i]
    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      continue
    }
    if (depth === 1) {
      const m = re.exec(objText.slice(i, i + field.length + 30))
      if (m) {
        const n = Number.parseFloat(m[1])
        return Number.isFinite(n) ? n : null
      }
    }
  }
  return null
}

/**
 * `resetInSec` is a DURATION from now, not a timestamp. A negative or absurd value means the
 * parse latched onto the wrong number, so it is rejected rather than rendered as a reset a
 * decade away — a wrong number displayed confidently is worse than no number.
 */
const MAX_RESET_SECONDS = 60 * 60 * 24 * 90

function resetToTimestamp(seconds: number | null): number | null {
  if (seconds === null || seconds < 0 || seconds > MAX_RESET_SECONDS) return null
  return Date.now() + seconds * 1000
}

function limitFrom(
  block: string | null,
  kind: string,
  group: string,
  windowMinutes: number
): UsageLimit | null {
  if (!block) return null
  const percent = topLevelNumber(block, 'usagePercent')
  if (percent === null) return null
  return {
    kind,
    group,
    usedPercent: Math.min(100, Math.max(0, percent)),
    severity: null,
    resetsAt: resetToTimestamp(topLevelNumber(block, 'resetInSec')),
    windowMinutes,
    scopeLabel: null,
    isActive: false
  }
}

/**
 * Parse the dashboard page. Returns [] when nothing usable is found — the caller turns that
 * into an 'error', because a configured provider that yields nothing is broken, not idle.
 */
export function parseOpencodePage(text: string): UsageLimit[] {
  // A page far larger than any dashboard means we fetched something else (a redirect to a
  // marketing page, an error shell); refuse rather than burn time brace-scanning it.
  if (!text || text.length > 10_000_000) return []

  const rolling = limitFrom(extractUsageBlock(text, 'rollingUsage'), 'session', 'session', ROLLING_WINDOW_MINUTES)
  const weekly = limitFrom(extractUsageBlock(text, 'weeklyUsage'), 'weekly_all', 'weekly', WEEKLY_WINDOW_MINUTES)
  const monthly = limitFrom(extractUsageBlock(text, 'monthlyUsage'), 'monthly_all', 'monthly', MONTHLY_WINDOW_MINUTES)

  // Rolling and weekly are the two every plan has. If neither parsed, the format moved under
  // us and a lone `monthly` is more likely a coincidental match than real data.
  if (!rolling && !weekly) return []
  return [rolling, weekly, monthly].filter((l): l is UsageLimit => l !== null)
}

/** Workspace ids embedded in the server-function response. */
export function parseWorkspaceIds(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\bid\s*:\s*["']((?:wrk|wk)_[a-zA-Z0-9]+)["']/g)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id)
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'opencode', limits, account: null, updatedAt: Date.now(), status }
}

async function get(url: string, headers: Record<string, string>): Promise<Response | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * opencode usage.
 *
 * Status semantics are deliberately sharp here: no cookie ⇒ 'unavailable' (nothing to show);
 * cookie present but nothing parsed ⇒ 'error' (something we depend on changed). Collapsing
 * those two would let a broken scraper masquerade as an unconfigured provider.
 */
export async function fetchOpencodeUsage(
  cookie: string | null,
  workspaceIdOverride?: string
): Promise<ProviderUsage> {
  const normalized = normalizeCookieInput(cookie ?? '')
  const authCookie = normalized ? filterAuthCookie(normalized) : null
  if (!authCookie) return snapshot([], 'unavailable')

  try {
    const headers = { cookie: authCookie, accept: 'text/html,application/json' }

    // A user-supplied workspace id skips discovery entirely — the escape hatch for when the
    // hardcoded server-function hash goes stale.
    let workspaceIds: string[] = []
    const override = workspaceIdOverride?.trim()
    if (override) {
      if (!isValidWorkspaceId(override)) return snapshot([], 'error')
      workspaceIds = [override]
    } else {
      const res = await get(`${SERVER_URL}?id=${WORKSPACES_SERVER_ID}`, {
        ...headers,
        'x-server-id': WORKSPACES_SERVER_ID,
        'x-server-instance': `server-fn:${WORKSPACES_SERVER_ID}`
      })
      if (!res) return snapshot([], 'error')
      if (res.status === 401 || res.status === 403) return snapshot([], 'unavailable')
      if (!res.ok) return snapshot([], 'error')
      workspaceIds = parseWorkspaceIds(await res.text())
    }
    if (workspaceIds.length === 0) return snapshot([], 'error')

    // Several workspaces can be visible; the first that yields usable numbers wins.
    for (const id of workspaceIds) {
      const page = await get(`${BASE_URL}/workspace/${id}/go`, headers)
      if (!page) continue
      if (page.status === 401 || page.status === 403) return snapshot([], 'unavailable')
      if (!page.ok) continue
      const limits = parseOpencodePage(await page.text())
      if (limits.length > 0) return snapshot(limits, 'ok')
    }

    // Authenticated, workspaces found, nothing parsed: the page shape moved. Report it.
    return snapshot([], 'error')
  } catch {
    return snapshot([], 'error')
  }
}
