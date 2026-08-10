import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { codexContextParse, pickCodexUsage } from './codex-session'

// A REAL codex-cli rollout, captured from
// ~/.codex/sessions/2026/07/25/rollout-2026-07-25T21-48-38-019f9b40-….jsonl. Its own `session_meta`
// states the version: `cli_version: "0.145.0"` (the `--help` vocabulary this module was written
// against was read off 0.146.0 — the two agree on every field used here).
//
// A MULTI-TURN rollout on purpose: `total_token_usage` runs 17855 → 204277 while `last_token_usage`
// runs 17855 → 34635. That divergence is the whole point of the fixture — `total_token_usage` is
// CUMULATIVE over the session (it would read 79% of a 258400 window on a session that is really 13%
// full, and would cross 100% a couple of turns later), so only `last_token_usage` can be a
// context-window numerator. The newest single-turn rollout could not tell the two apart: there they
// are equal.
//
// Numbers read out of the file:
//   - last `token_count` → payload.info.last_token_usage:
//       {"input_tokens":34635,"cached_input_tokens":33536,"cache_write_input_tokens":0,
//        "output_tokens":169,"reasoning_output_tokens":109,"total_tokens":34804}
//   - payload.info.model_context_window: 258400
//   - the `turn_context` line's payload.model: "gpt-5.6-sol"
//
// ---------------------------------------------------------------------------------------------
// PRUNED, DELIBERATELY — do not "restore the full capture".
//
// The rollout as captured was 132 KB of somebody's real working session, and this repository is
// PUBLIC. What was removed, and why:
//   - every `response_item`, `world_state`, `agent_message`, `reasoning` and
//     `function_call{,_output}` line: six `encrypted_content` blobs, two `developer_instructions`
//     blocks, ~21 KB of verbatim handoff notes (real product discussion, plus a third party's
//     environment dump) and absolute `/Users/<name>/…` paths.
//   - `session_meta.base_instructions`: OpenAI's ~15 KB shipped system prompt, verbatim.
//   - `session_meta.git`: commit hash, branch and repository URL.
//   - `turn_context.timezone`, `.permission_profile`, `.file_system_sandbox_policy` and
//     `.collaboration_mode` (the last one carries another `developer_instructions` block).
//   - `token_count.rate_limits`: the account's plan type, credit balance and reset timestamps.
//   - four of the seven `token_count` events; the three kept are the FIRST (where the two totals
//     are still equal), one middle, and the LAST.
// Nothing removed is read by any test. Everything kept is byte-for-byte as codex wrote it — the
// value of this fixture is that its numbers and field shapes are genuine, so if a test's expected
// number ever changes when this file is edited, the edit is wrong, not the test.
// ---------------------------------------------------------------------------------------------
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
