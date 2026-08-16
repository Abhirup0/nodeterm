/**
 * Secret redaction for the debug log ring (issue #78). Applied INSIDE LogBuffer.push(), not at
 * the IPC boundary: the invariant being upheld is pairing-core's "NEVER sent to the renderer" —
 * once a value exists unredacted in the ring, any later consumer (the panel, an export, a crash
 * report someone pastes) can leak it, so nothing unredacted may enter the ring at all.
 *
 * The list is deny-by-name plus a few well-known token SHAPES. Deliberately NOT a generic
 * high-entropy matcher: git SHAs, node ids and file paths are exactly what makes a debug log
 * useful, and an entropy heuristic eats them.
 */

/**
 * Env-var / config names whose VALUE is a credential when logged as `NAME=x`, `NAME: x` or
 * `"NAME":"x"`. Seeded from AUTH_ENV_STRIP (claude-accounts-core) plus every token-bearing
 * name this codebase actually sets — keep in sync when a new one appears.
 */
export const SECRET_VALUE_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NODETERM_HOOK_TOKEN',
  'NODETERM_ASKPASS_TOKEN',
  'NODETERM_SERVER_PASSWORD',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GROK_CLI_AUTH_HEADER',
  'access_token',
  'refresh_token'
]

const REPLACEMENT = '[redacted]'

// `NAME=value` / `NAME: value` / `"NAME":"value"` — the value runs to whitespace or a closing
// quote, so a token never survives partially. Case-insensitive: headers and JSON keys vary.
const namePattern = new RegExp(
  `(["']?(?:${SECRET_VALUE_NAMES.join('|')})["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|\\S+)`,
  'gi'
)

// Authorization / token-carrying headers, whatever the scheme (Bearer, Basic, token …).
const headerPattern = /((?:authorization|proxy-authorization|x-nodeterm-[a-z-]*token|cookie|set-cookie)\s*[=:]\s*)([^\r\n]+)/gi

// Well-known token shapes that appear WITHOUT a name label (argv echoes, pasted URLs):
// Anthropic sk-ant-…, generic sk-…, GitHub ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained PATs.
const shapePattern = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g

/** Redact known credentials from one log line. Pure; idempotent. */
export function redactSecrets(text: string): string {
  return text
    .replace(namePattern, (_m, head: string) => `${head}${REPLACEMENT}`)
    .replace(headerPattern, (_m, head: string) => `${head}${REPLACEMENT}`)
    .replace(shapePattern, REPLACEMENT)
}
