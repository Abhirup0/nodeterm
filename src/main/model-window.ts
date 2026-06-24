// Resolves a Claude model id → its EFFECTIVE context window (max input tokens).
//
// Claude Code's effective window is 200k by default and 1M only for extended-context
// ("[1m]") models — the same default ccstatusline and Claude Code's own status line use.
// The Anthropic Models API's max_input_tokens reports the model's *capability* (1M for
// opus/sonnet), not the session's *effective* window, so it is intentionally NOT consulted
// here — using it understated fill ~5x. Resolution is fully synchronous (no network).

const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

// Matches a "1m" extended-context marker as a standalone token anywhere in the id, e.g.
// "[1m]", "-1m", " 1m ", or a trailing "1m". Plain ids like "claude-opus-4-8" do not match.
const ONE_M = /(^|[^a-z0-9])1m([^a-z0-9]|$)/i

/** Effective context window for a model id: 1M only for [1m] models, else 200k. */
export function staticWindowFor(model: string | null): number {
  return model && ONE_M.test(model) ? LARGE_WINDOW : DEFAULT_WINDOW
}

/** Synchronous best guess for the model's window (no cache/network needed). */
export function cachedWindowFor(model: string | null): number {
  return staticWindowFor(model)
}

/**
 * Kept only for call-site compatibility with context-tail.ts. Window resolution is now fully
 * synchronous via cachedWindowFor/staticWindowFor, so there is nothing to resolve — no-op.
 */
export async function resolveModelWindow(_model: string | null): Promise<void> {
  // intentional no-op
}
