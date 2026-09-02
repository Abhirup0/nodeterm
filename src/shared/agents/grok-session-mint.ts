// Choosing a grok session id that grok will actually accept. PURE — no fs, so the renderer's
// synchronous node factory can call it. The directory read that feeds `taken` lives in
// `core/grok-session-mint.ts`, which is node-side.
//
// grok's `--session-id` is stricter than claude's in a way that turns OUR bug into a node that does
// not start (measured, 1.0.13): *"must be a valid UUID and must not already exist under the target
// session directory"*. Handing it an id already on disk is a LAUNCH ERROR, not a resume — grok
// exits, and the user sees a terminal that died instead of an agent.
/** How many candidates to try before giving up and minting nothing. A v4 collision is already
 *  implausible; three consecutive ones mean the generator is broken, and in that case NO id is the
 *  correct answer — the node falls back to learning its id from a hook, exactly as before minting
 *  existed. Looping forever on a broken generator would hang node creation instead. */
const MAX_ATTEMPTS = 3

/**
 * Pure: pick an id no existing session already owns.
 *
 * `taken` is the set of session ids already on disk for this cwd; `gen` mints candidates. Returns
 * undefined when every attempt collided, which the caller must read as "launch without the flag",
 * never as "launch with a taken id".
 */
export function mintFreeGrokSessionId(
  taken: ReadonlySet<string>,
  gen: () => string
): string | undefined {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = gen()
    if (candidate && !taken.has(candidate)) return candidate
  }
  return undefined
}

