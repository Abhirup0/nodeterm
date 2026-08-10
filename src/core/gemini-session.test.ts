import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { geminiContextParse, pickGeminiTokens, pickGeminiTitle } from './gemini-session'
import { geminiWindowFor } from './model-window'

// A REAL gemini 0.54.4 transcript, captured from
// ~/.gemini/tmp/nodeterm/chats/session-2026-08-09T10-48-fd01438b.jsonl.
// Its numbers (read out of the file, not invented):
//   - last line carrying `tokens` (line 6):
//       {"input":17149,"output":29,"cached":7760,"thoughts":171,"tool":0,"total":17349}
//   - `model` on that same line: "gemini-3.5-flash"
//   - last `update_topic` tool call's `args.title` (line 5): "Test Environment Verified"
//
// PRUNED, DELIBERATELY — do not "restore the full capture". This repository is public, and the
// capture's line 2 (gemini's own `<session_context>` preamble, replayed inside a `$set.messages`
// history sync) carried a 200-entry listing of the working tree, naming untracked scratch files.
// That listing is cut at "- **Directory Structure:**" and marked; nothing else inside the kept
// records was altered. The 24 lines dropped were ordinary turns — assistant text, thoughts, tool
// calls and the `$set.lastUpdated` records between them — that no test reads. What is kept is
// exactly what the tests assert on plus the shapes they are about: the session header, one
// `$set.messages` sync, one plain user turn, one `$set.lastUpdated`, the newest `update_topic`
// call, and the newest line carrying `tokens` + `model`. Every number and field name in them is
// byte-for-byte as gemini wrote it, so if an expected number changes when this file is edited,
// the edit is wrong, not the test.
const transcript = readFileSync(path.join(__dirname, '__fixtures__/gemini/session.jsonl'), 'utf8')

describe('pickGeminiTokens', () => {
  it("reads the LATEST turn's token counts from a real transcript", () => {
    // 17149 is the last line's `input`. 1048576 is gemini's own DEFAULT_TOKEN_LIMIT, which
    // `tokenLimit()` returns for "gemini-3.5-flash" (it matches none of the switch's cases).
    expect(pickGeminiTokens(transcript)).toEqual({ usedTokens: 17149, windowTokens: 1048576 })
  })

  it('takes `input` as the used count, not `total` and not `input + cached`', () => {
    // `input` is what fills the window at that turn; `total` folds in output + thoughts, which have
    // already left the prompt (proved by the fixture: input+output+thoughts+tool === total on every
    // line). Cached input still occupies the window and is ALREADY INSIDE `input` — `cached` is a
    // subset, not an addend, so adding it would double-count.
    const line = JSON.stringify({ tokens: { input: 100, output: 50, cached: 20, thoughts: 5, tool: 0, total: 155 } })
    expect(pickGeminiTokens(line)?.usedTokens).toBe(100)
  })

  it('states no window when the transcript names no model', () => {
    // Gemini's window is resolved from the model id, so a line without one has no trustworthy
    // denominator — null, and the tail then pushes nothing.
    const line = JSON.stringify({ tokens: { input: 100, total: 100 } })
    expect(pickGeminiTokens(line)).toEqual({ usedTokens: 100, windowTokens: null })
  })

  it('returns null when no turn has tokens yet, and survives a torn line', () => {
    expect(pickGeminiTokens('')).toBeNull()
    expect(pickGeminiTokens('{ not json\n')).toBeNull()
    expect(pickGeminiTokens(JSON.stringify({ tokens: { input: 0, total: 0 } }))).toBeNull()
  })

  it('ignores a line that merely CONTAINS "tokens" without a top-level tokens object', () => {
    // The transcript's `$set` history-sync line (fixture line 2) is exactly this shape: it mentions
    // the word but carries no top-level counts, so the scan must keep walking backwards.
    const text = [
      JSON.stringify({ tokens: { input: 42, total: 42 }, model: 'gemini-2.5-pro' }),
      JSON.stringify({ $set: { messages: [{ note: 'mentions tokens but has none' }] } })
    ].join('\n')
    expect(pickGeminiTokens(text)).toEqual({ usedTokens: 42, windowTokens: 1048576 })
  })
})

describe('geminiContextParse', () => {
  it('returns the shape createContextTail consumes, model included', () => {
    expect(geminiContextParse(transcript)).toEqual({
      used: 17149,
      window: 1048576,
      model: 'gemini-3.5-flash'
    })
  })

  it('accepts a pre-split line array like the tail passes', () => {
    expect(geminiContextParse(transcript.split('\n'))?.used).toBe(17149)
  })

  it('returns null for a transcript with no usage', () => {
    expect(geminiContextParse('')).toBeNull()
  })
})

describe('geminiWindowFor', () => {
  // Mirrors gemini-cli 0.54.4's own `tokenLimit(model)`
  // (bundle/chunk-BS6BSLZD.js:331674-331686).
  it('answers gemini-cli DEFAULT_TOKEN_LIMIT for the switch cases and for unknown models', () => {
    for (const m of [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.5-flash', // in NEITHER list — lands on the `default:` branch, like the fixture
      'some-model-shipped-next-week'
    ]) {
      expect(geminiWindowFor(m)).toBe(1048576)
    }
  })

  it('answers GEMMA_4_TOKEN_LIMIT for the two gemma models — the only special case', () => {
    expect(geminiWindowFor('gemma-4-31b-it')).toBe(256000)
    expect(geminiWindowFor('gemma-4-26b-a4b-it')).toBe(256000)
  })

  it('answers null when there is no model at all', () => {
    expect(geminiWindowFor(null)).toBeNull()
    expect(geminiWindowFor('')).toBeNull()
  })
})

describe('pickGeminiTitle', () => {
  it('reads the LATEST update_topic title from a real transcript', () => {
    expect(pickGeminiTitle(transcript)).toBe('Test Environment Verified')
  })

  it('reads the title out of the update_topic tool call, not a top-level field', () => {
    // Gemini has no top-level `title` in its transcript lines (verified against the fixture: no
    // line parses to an object with one). The name it displays is the `update_topic` tool's
    // `args.title`.
    const line = JSON.stringify({
      id: 'x',
      type: 'gemini',
      toolCalls: [{ id: 'update_topic__a', name: 'update_topic', args: { title: '  Spaced  ' } }]
    })
    expect(pickGeminiTitle(line)).toBe('Spaced')
  })

  it('ignores a title-shaped arg on some OTHER tool', () => {
    const line = JSON.stringify({
      toolCalls: [{ id: 'write_file__a', name: 'write_file', args: { title: 'not a session name' } }]
    })
    expect(pickGeminiTitle(line)).toBeNull()
  })

  it('returns null for a transcript with no title and for junk', () => {
    expect(pickGeminiTitle('{"tokens":{"input":1,"total":1}}')).toBeNull()
    expect(pickGeminiTitle('nonsense')).toBeNull()
    expect(pickGeminiTitle('')).toBeNull()
  })

  it('finds a title carried inside a `$set.messages` history sync', () => {
    // `$set.messages` is an IN-SESSION history sync: gemini writes the whole array when it rewrites
    // the conversation it holds in memory (bundle chunk-TYAF55F7.js:285852-285857) and reads that
    // array as REPLACING the history (:285303-285335). It is NOT a resume replay — measured on
    // 0.54.4, `--resume` appends to the same file and writes only `{"$set":{"sessionId":…}}`
    // (:285453). The walk is kept as defence: such a record can be the newest line in the file, and
    // a title inside it is one the session currently believes in.
    //
    // Both shapes are measured in the fixture: `$set.messages` as an array of ordinary message
    // objects (line 2), and a `gemini` message carrying `toolCalls[].args.title` (line 5).
    const line = JSON.stringify({
      $set: {
        messages: [
          { id: 'a', type: 'user', content: [{ text: 'test' }] },
          {
            id: 'b',
            type: 'gemini',
            toolCalls: [{ id: 'update_topic__a', name: 'update_topic', args: { title: 'Synced Topic' } }]
          }
        ],
        lastUpdated: '2026-08-09T10:48:49.538Z'
      }
    })
    expect(pickGeminiTitle(line)).toBe('Synced Topic')
  })

  it('prefers a top-level title over one carried in an earlier sync record', () => {
    // A sync record states the history as of the moment it was written, so anything top-level AFTER
    // it is newer. The backward scan gives that for free; this pins it.
    const synced = JSON.stringify({
      $set: {
        messages: [
          {
            id: 'b',
            type: 'gemini',
            toolCalls: [{ name: 'update_topic', args: { title: 'Old Topic' } }]
          }
        ]
      }
    })
    const fresh = JSON.stringify({
      id: 'c',
      type: 'gemini',
      toolCalls: [{ name: 'update_topic', args: { title: 'New Topic' } }]
    })
    expect(pickGeminiTitle(`${synced}\n${fresh}`)).toBe('New Topic')
  })

  it('ignores a nested title-shaped arg on some other tool', () => {
    const line = JSON.stringify({
      $set: {
        messages: [
          { id: 'b', type: 'gemini', toolCalls: [{ name: 'write_file', args: { title: 'not a name' } }] }
        ]
      }
    })
    expect(pickGeminiTitle(line)).toBeNull()
  })
})
