// grok's per-session context numbers, from `~/.grok/sessions/<cwd>/<id>/signals.json`.
//
// NOT to be confused with `core/usage/grok-usage.ts`, which is the account's weekly/monthly plan
// credit read from the billing endpoint. That is a BILLING figure for the whole account; this is the
// context window of ONE session. They are different numbers with similar names, and merging them
// would put a quota percentage on a per-node meter.
//
// The file is grok's metrics dump: 66 keys on the sessions measured (latencies, GCS queue counters,
// lines touched, peak RSS). Exactly three matter here, and nothing else is read — a metrics file is
// free to grow keys, and a reader that pattern-matches loosely would start reporting whatever gets
// added next.
import path from 'path'
import fs from 'fs'
import { grokSessionDirFor } from './grok-session'

/** grok's own name for the file. Sibling of `chat_history.jsonl` in the session directory. */
export const GROK_SIGNALS_FILE = 'signals.json'

export interface GrokContextNumbers {
  used: number
  window: number
  /** grok's OWN percentage, already computed and truncated to an integer. */
  statedPercent: number | null
  model: string | null
}

/**
 * Parse a whole `signals.json` buffer.
 *
 * MEASURED on 22 real sessions (grok 1.0.13, 2026-09-02): `contextTokensUsed` and
 * `contextWindowTokens` are present in all 22, and `contextWindowUsage` — the percentage grok has
 * already computed — matches `used/window` in all 22. That makes grok the only agent that states the
 * numerator, the denominator AND the answer.
 *
 * Returns null unless BOTH numbers are present and usable. That is the project's degrade rule and it
 * is not defensive noise: a meter drawn against a guessed window is a wrong number presented as a
 * fact, and the correct behaviour without a trustworthy denominator is NO METER. Do not add a
 * fallback window here from the model id — grok states its own, and inferring one would silently
 * replace a measured fact with a guess the day grok ships a different window.
 */
export function grokSignalsParse(buf: string): GrokContextNumbers | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(buf) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const used = o.contextTokensUsed
  const window = o.contextWindowTokens
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return null
  const stated = o.contextWindowUsage
  const model = o.primaryModelId
  return {
    used,
    window,
    statedPercent: typeof stated === 'number' && Number.isFinite(stated) ? stated : null,
    model: typeof model === 'string' && model ? model : null
  }
}

/**
 * Shaped for `ContextTail`'s `parse` dep, which hands the reader whatever it just read.
 *
 * The tail must be created with `wholeFile: true` for grok: `signals.json` is REWRITTEN in place,
 * not appended to, so an offset read would hand this function a fragment of JSON and every parse
 * after the first would fail — silently, as a meter that filled once and then froze.
 */
export function grokContextParse(
  text: string | string[]
): { used: number; window: number | null; model: string | null } | null {
  const buf = Array.isArray(text) ? text.join('\n') : text
  const r = grokSignalsParse(buf)
  return r ? { used: r.used, window: r.window, model: r.model } : null
}

/** The signals file for a session a hook has located, or undefined. Derived, never searched — the
 *  same rule `locateGrok` follows, and for the same reason: a scan keyed on anything weaker than the
 *  session id can settle on another session's numbers. */
export function grokSignalsPathFor(sessionId: string | undefined): string | undefined {
  const dir = grokSessionDirFor(sessionId)
  return dir ? path.join(dir, GROK_SIGNALS_FILE) : undefined
}

/** Read and parse in one step. undefined when the session is unknown, the file is absent, or the
 *  numbers are not both there. */
export async function readGrokContextNumbers(
  sessionId: string | undefined
): Promise<GrokContextNumbers | null> {
  const p = grokSignalsPathFor(sessionId)
  if (!p) return null
  let buf: string
  try {
    buf = await fs.promises.readFile(p, 'utf8')
  } catch {
    return null
  }
  return grokSignalsParse(buf)
}
