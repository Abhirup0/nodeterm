/**
 * Pure line-based text codecs for the `env` / `sharedPaths` textareas in the project settings
 * family editors (Task 4). These mirror the shared sanitizer's rules for the same fields
 * (`src/shared/project-settings.ts`: `ENV_KEY_RE`, the explicit `__proto__` rejection) but exist
 * for a different reason: the sanitizer must never throw on hostile git-shared input, so it
 * silently DROPS anything it does not recognize. That is wrong for an editor — a user who typed
 * `bad key=1` needs to see that the line was ignored, not just watch it vanish on save. So this
 * codec REPORTS every rejected line back to the caller; the UI turns that into a warn note.
 */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Splits on any line ending (CRLF, CR, or LF) so a file edited on Windows round-trips cleanly. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

export function parseEnvLines(text: string): { env: Record<string, string>; rejected: string[] } {
  const env: Record<string, string> = {}
  const rejected: string[] = []
  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim()
    if (line === '') continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      rejected.push(line)
      continue
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    // `__proto__` matches ENV_KEY_RE lexically but must never become a real own key — same
    // exclusion as `sanitizeEnv` in the shared module, for the same reason.
    if (key === '__proto__' || !ENV_KEY_RE.test(key)) {
      rejected.push(line)
      continue
    }
    env[key] = value
  }
  return { env, rejected }
}

export function formatEnvLines(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n')
}

/** Trims each line and drops empties. Anything else (traversal segments, absolute paths, caps,
 *  duplicates) is the shared sanitizer's job — this codec only turns text into candidate strings. */
export function parseListLines(text: string): string[] {
  return splitLines(text)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

export function formatListLines(items: string[] | undefined): string {
  if (!items || items.length === 0) return ''
  return items.join('\n')
}
