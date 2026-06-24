// Resolves a Claude model id → its context window (max input tokens).
//
// Empirically (verified via `/context` on this machine) Claude Code runs opus/sonnet/fable
// sessions in a 1M window — the model id in the transcript stays bare ("claude-opus-4-8")
// even when 1M is active, so the window can NOT be detected from the id alone. We therefore
// map the model FAMILY to its window: opus/sonnet/fable/mythos → 1M, haiku → 200k, unknown
// → 200k. (Accounts with 1M access see the right denominator; the Models API is not consulted
// — it returns capability, and the call added latency for no gain.) Fully synchronous.

const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

// Model family → window. First match wins; an explicit "1m" marker also forces the large
// window. Plain ids like "claude-opus-4-8" resolve to 1M via the opus/sonnet/fable rule.
const STATIC: Array<[RegExp, number]> = [
  [/haiku/i, DEFAULT_WINDOW],
  [/opus|sonnet|fable|mythos|(^|[^a-z0-9])1m([^a-z0-9]|$)/i, LARGE_WINDOW]
]

/** Context window for a model id: 1M for opus/sonnet/fable/[1m], 200k for haiku/unknown. */
export function staticWindowFor(model: string | null): number {
  if (model) {
    for (const [re, win] of STATIC) if (re.test(model)) return win
  }
  return DEFAULT_WINDOW
}

/** Synchronous best guess for the model's window (no cache/network needed). */
export function cachedWindowFor(model: string | null): number {
  return staticWindowFor(model)
}

/**
 * Kept only for call-site compatibility with context-tail.ts. Window resolution is fully
 * synchronous via cachedWindowFor/staticWindowFor, so there is nothing to resolve — no-op.
 */
export async function resolveModelWindow(_model: string | null): Promise<void> {
  // intentional no-op
}
