// Readers over a gemini transcript (`~/.gemini/tmp/<project>/chats/session-*.jsonl` — the same
// root `handoff/locate.ts`'s `locateGemini` walks). Gemini's hook envelope carries
// `transcript_path` in its base input schema (its bundled `docs/hooks/reference.md:48-58`, the
// line the `GeminiPayload` comment in shared/agents/normalize.ts already cites), so unlike grok
// there is nothing to derive — the shells hand us the path.
//
// Deliberately NOT the `AfterModel` hook, which carries
// `llm_response.usageMetadata.totalTokenCount` but fires for EVERY streamed chunk
// (reference.md:236-237): that would be one hook process per chunk.
import { geminiWindowFor } from './model-window'

/** What a meter needs. `windowTokens: null` = we could not establish a TRUSTWORTHY window; show no
 *  meter rather than divide by a guess. */
export interface AgentUsage {
  usedTokens: number
  windowTokens: number | null
}

/**
 * Scan lines BACKWARDS for the newest JSON object whose TOP LEVEL is worth parsing, so a long
 * transcript costs the tail rather than the whole file. `needle` is only a cheap pre-filter (skip
 * the JSON.parse on lines that cannot match); `accept` decides, and the scan keeps walking when it
 * says no — a line can mention a key deep inside without carrying it at the top level. Gemini's
 * `$set` history-replay line is exactly that case: it contains the word `tokens` inside a nested
 * messages array while its own top level is just `{"$set":…}`.
 *
 * Shared with `codex-session.ts`, which lives beside this file and imports it rather than keeping a
 * second copy of the same walk.
 */
export function latestJsonLineWhere<T>(
  text: string | string[],
  needle: string,
  accept: (o: Record<string, unknown>) => T | null
): T | null {
  const lines = Array.isArray(text) ? text : text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim()
    if (!s || !s.includes(needle)) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue // a torn tail line costs only itself
    }
    if (!o || typeof o !== 'object') continue
    const hit = accept(o)
    if (hit !== null) return hit
  }
  return null
}

/** A gemini turn line's `tokens` block, as measured in a real 0.54.4 transcript. */
interface GeminiTokens {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
  tool?: number
  total?: number
}

/**
 * The latest turn's used tokens, the window that follows from its model, and the model id — the
 * exact shape `createContextTail`'s `parse` dep consumes.
 *
 * `input` is the used count. It is what fills the window at that turn, while `total` folds in
 * `output` and `thoughts`, which have already left the prompt — the fixture proves the split:
 * `input + output + thoughts + tool === total` on every line. `cached` is NOT added: it is a SUBSET
 * of `input` (cached input still occupies the window, and is already counted there), so adding it
 * would double-count.
 *
 * Measured shape (gemini 0.54.4, `__fixtures__/gemini/session.jsonl` line 6):
 *   "tokens":{"input":17149,"output":29,"cached":7760,"thoughts":171,"tool":0,"total":17349},
 *   "model":"gemini-3.5-flash"
 *
 * Both fields sit on the SAME line, which is what lets one backward scan settle used AND window.
 */
export function geminiContextParse(
  text: string | string[]
): { used: number; window: number | null; model: string | null } | null {
  return latestJsonLineWhere(text, '"tokens"', (o) => {
    const t = o.tokens as GeminiTokens | undefined
    if (!t || typeof t !== 'object') return null
    const input = t.input
    if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return null
    const model = typeof o.model === 'string' && o.model ? o.model : null
    return { used: input, window: geminiWindowFor(model), model }
  })
}

/** `geminiContextParse` narrowed to what a meter needs. See it for why `input` is the used count. */
export function pickGeminiTokens(transcript: string | string[]): AgentUsage | null {
  const r = geminiContextParse(transcript)
  return r ? { usedTokens: r.used, windowTokens: r.window } : null
}

/** One transcript message, as far as the title reader cares: it may carry tool calls. */
interface GeminiMessage {
  toolCalls?: unknown
}

/** The newest `update_topic` title among a line's tool calls, or null. Last call wins within a
 *  line: a line can hold several, and the newest is the name. Matched on the tool NAME so a
 *  `title` argument belonging to some other tool can never be mistaken for the session's name. */
function titleFromToolCalls(calls: unknown): string | null {
  if (!Array.isArray(calls)) return null
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i] as { name?: unknown; args?: { title?: unknown } } | null
    if (!c || c.name !== 'update_topic') continue
    const title = c.args?.title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  return null
}

/**
 * The latest session title gemini has given the conversation — what the node title adopts
 * (`TITLE_READ_CAPABLE`, routed in core/agent-session-name.ts).
 *
 * It is NOT a top-level transcript field — verified against the captured fixture, where no line
 * parses to an object with a `title`. Gemini names the conversation through its own `update_topic`
 * tool, so the name lives in that tool call's arguments:
 *   "toolCalls":[{"name":"update_topic","args":{"title":"Test Environment Verified", …}}]
 * (`__fixtures__/gemini/session.jsonl` line 5).
 *
 * TWO PLACES, and NOT because of RESUME. `$set.messages` is also walked, but the reason first
 * written here was wrong, and is corrected on the record rather than quietly deleted: a resume does
 * not replay history. Measured in gemini 0.54.4's bundle, `--resume` APPENDS to the same file and
 * writes exactly one record, `{"$set":{"sessionId":…}}` (`chunk-TYAF55F7.js:285453`); the only branch
 * that re-writes messages is the legacy `.json` → `.jsonl` migration, and it appends each one as an
 * ordinary line (`:285430-285450`). So a title set before a resume is still a top-level
 * `update_topic` line, which the backward scan finds unaided.
 *
 * What `$set.messages` actually is: an in-session HISTORY SYNC, written whenever gemini rewrites the
 * conversation it holds in memory (`:285852-285857`) and read by gemini itself as REPLACING the
 * history (`:285303-285335`). The never-resumed fixture carries one at line 2. Since that record can
 * be the newest line in the file and does carry messages, a title inside it is one the session
 * currently believes in — so the walk stays, as DEFENCE rather than as a resume path. It is free (the
 * `"title"` needle keeps every line without one out of it), it matches only `update_topic`, and it
 * cannot invent a name. Both shapes it walks are measured in the fixture (`$set.messages` at line 2,
 * `toolCalls[].args.title` at line 5).
 *
 * Ordering is right for free: the backward line scan takes the NEWEST matching line, so a top-level
 * title written after a history sync wins over one nested inside it.
 *
 * Read-only: gemini has no rename command (`/chat save <tag>` is a checkpoint, not a title), so
 * nothing pushes a node title back the other way — gemini is in TITLE_READ_CAPABLE and deliberately
 * NOT in RENAME_CAPABLE.
 */
export function pickGeminiTitle(transcript: string | string[]): string | null {
  return latestJsonLineWhere(transcript, '"title"', (o) => {
    const top = titleFromToolCalls(o.toolCalls)
    if (top) return top
    // The in-session history sync (NOT a resume replay — see the docblock). `$set` also carries
    // plain `{lastUpdated}` / `{sessionId}` records, which have no messages.
    const set = o.$set as { messages?: unknown } | undefined
    const messages = set && typeof set === 'object' ? set.messages : undefined
    if (!Array.isArray(messages)) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const hit = titleFromToolCalls((messages[i] as GeminiMessage | null)?.toolCalls)
      if (hit) return hit
    }
    return null
  })
}
