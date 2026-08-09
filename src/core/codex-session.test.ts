import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { codexContextParse, pickCodexUsage } from './codex-session'

// A REAL codex-cli 0.146.0 rollout, captured from
// ~/.codex/sessions/2026/07/26/rollout-2026-07-26T00-48-38-019f9b40-….jsonl.
//
// A MULTI-TURN rollout on purpose: it carries seven `token_count` events, and across them
// `total_token_usage` runs 17855 → 204277 while `last_token_usage` runs 17855 → 34635. That
// divergence is the whole point of the fixture — `total_token_usage` is CUMULATIVE over the
// session (it would read 79% of a 258400 window on a session that is really 13% full, and would
// cross 100% a couple of turns later), so only `last_token_usage` can be a context-window
// numerator. The newest single-turn rollout could not tell the two apart: there they are equal.
//
// Numbers read out of the file:
//   - last `token_count` → payload.info.last_token_usage:
//       {"input_tokens":34635,"cached_input_tokens":33792,"cache_write_input_tokens":0,
//        "output_tokens":…,"reasoning_output_tokens":…,"total_tokens":…}
//   - payload.info.model_context_window: 258400
//   - the `turn_context` line's payload.model: "gpt-5.6-sol"
const rollout = readFileSync(path.join(__dirname, '__fixtures__/codex/rollout.jsonl'), 'utf8')

describe('pickCodexUsage', () => {
  it('reads the used count AND the window from a real rollout', () => {
    // Codex states its own denominator — unlike claude, where model-window.ts has to infer one
    // from the model family.
    expect(pickCodexUsage(rollout)).toEqual({ usedTokens: 34635, windowTokens: 258400 })
  })

  it('reads last_token_usage, NOT the cumulative total_token_usage', () => {
    // The guard for the whole design: in this fixture the final total_token_usage.input_tokens is
    // 204277. If the reader ever goes back to the cumulative field, this fails loudly.
    expect(pickCodexUsage(rollout)?.usedTokens).not.toBe(204277)
  })

  it('counts cached input once — it is already inside input_tokens, not an addend', () => {
    // Proved against every usage record in ~/.codex/sessions: input_tokens + output_tokens ===
    // total_tokens, and cached_input_tokens <= input_tokens. So cached input is a SUBSET of
    // input_tokens (it occupies the window and is already counted); adding it would double-count.
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 5000, cached_input_tokens: 900, output_tokens: 7, total_tokens: 5007 },
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 7, total_tokens: 1007 },
          model_context_window: 4000
        }
      }
    })
    expect(pickCodexUsage(line)).toEqual({ usedTokens: 1000, windowTokens: 4000 })
  })

  it('returns a null window rather than guessing when the rollout omits it', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0 } }
      }
    })
    expect(pickCodexUsage(line)).toEqual({ usedTokens: 10, windowTokens: null })
  })

  it('returns null for junk, for an empty rollout, and when no usage was recorded', () => {
    expect(pickCodexUsage('')).toBeNull()
    expect(pickCodexUsage('{ oops')).toBeNull()
    // A rollout that has only started: session_meta + task_started, no token_count yet. Note
    // task_started DOES carry model_context_window — a window with no used count is still no meter.
    const started = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'a', cwd: '/tmp' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', model_context_window: 258400 } })
    ].join('\n')
    expect(pickCodexUsage(started)).toBeNull()
  })
})

describe('codexContextParse', () => {
  it('returns the shape createContextTail consumes, with the model from turn_context', () => {
    expect(codexContextParse(rollout)).toEqual({
      used: 34635,
      window: 258400,
      model: 'gpt-5.6-sol'
    })
  })

  it('accepts a pre-split line array like the tail passes', () => {
    expect(codexContextParse(rollout.split('\n'))?.used).toBe(34635)
  })

  it('reports a null model when the chunk carries no turn_context', () => {
    // The tail keeps the last model it was told (`t.model = latest.model ?? t.model`), so a later
    // chunk holding only token_count events must not claim to know one.
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0 },
          model_context_window: 100
        }
      }
    })
    expect(codexContextParse(line)).toEqual({ used: 10, window: 100, model: null })
  })

  it('returns null for a rollout with no usage', () => {
    expect(codexContextParse('')).toBeNull()
  })
})
