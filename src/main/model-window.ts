// Resolves a Claude model id → its context window (max input tokens).
// Precedence: in-memory cache → Anthropic Models API (max_input_tokens) → static table
// → 200k default. Runs in the main process; reuses the OAuth token from claude-usage.
import { resolveClaudeAccessToken } from './claude-usage'

const MODELS_URL = 'https://api.anthropic.com/v1/models/'
const OAUTH_BETA = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 8000
const DEFAULT_WINDOW = 200_000

// Known windows from the Anthropic model catalog; substring match so dated/suffixed ids resolve.
const STATIC: Array<[RegExp, number]> = [
  [/haiku/i, 200_000],
  [/opus|sonnet|fable|mythos/i, 1_000_000]
]

/** Best-effort window from the static table; 200k if nothing matches. */
export function staticWindowFor(model: string | null): number {
  if (model) {
    for (const [re, win] of STATIC) if (re.test(model)) return win
  }
  return DEFAULT_WINDOW
}

const cache = new Map<string, number>()
const requested = new Set<string>()

/** Synchronous best guess: cached API value if present, else the static table. */
export function cachedWindowFor(model: string | null): number {
  if (model && cache.has(model)) return cache.get(model) as number
  return staticWindowFor(model)
}

/**
 * Resolve a model's window from the Models API and cache it. Fired once per model id
 * (self-gates on cache/requested). On any failure, caches the static-table value so we
 * don't refetch every tick. Never throws.
 */
export async function resolveModelWindow(model: string | null): Promise<void> {
  if (!model || cache.has(model) || requested.has(model)) return
  requested.add(model)
  let resolved = staticWindowFor(model)
  try {
    const token = await resolveClaudeAccessToken()
    if (token) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      const res = await fetch(MODELS_URL + encodeURIComponent(model), {
        signal: ctrl.signal,
        cache: 'no-cache',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'anthropic-version': '2023-06-01'
        }
      }).finally(() => clearTimeout(t))
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>
        const max = data.max_input_tokens
        if (typeof max === 'number' && max > 0) resolved = max
      }
    }
  } catch {
    // network/parse failure — keep the static fallback
  }
  cache.set(model, resolved)
}
