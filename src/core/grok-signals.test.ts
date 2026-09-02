import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { grokSignalsParse, grokContextParse } from './grok-signals'

// Captured whole from a real session (grok 1.0.13). Kept entire rather than trimmed to the three
// keys we read: the point of the fixture is to prove the reader ignores the other 63.
const RAW = fs.readFileSync(path.join(__dirname, '__fixtures__/grok/signals.json'), 'utf8')

describe('grokSignalsParse', () => {
  it('reads the numerator and the denominator grok states', () => {
    const r = grokSignalsParse(RAW)
    expect(r).not.toBeNull()
    expect(r!.used).toBe(381615)
    expect(r!.window).toBe(500000)
    expect(r!.model).toBe('grok-4.6')
  })

  it("agrees with grok's OWN percentage — the oracle this agent gives us for free", () => {
    // grok is the only agent that states the answer as well as both operands. If our arithmetic
    // ever disagrees with its `contextWindowUsage`, one of the two changed: a rounding rule, a key
    // meaning, a new denominator. This test is what makes that a failure instead of a meter quietly
    // off by a percent.
    const r = grokSignalsParse(RAW)!
    expect(r.statedPercent).toBe(76)
    expect(Math.floor((r.used / r.window) * 100)).toBe(r.statedPercent)
  })

  it('returns null when the WINDOW is missing — no denominator, no meter', () => {
    // The degrade rule, and the mutation target: a meter drawn against a guessed window is a wrong
    // number presented as a fact. Nothing here may fall back to a window inferred from the model.
    const o = JSON.parse(RAW)
    delete o.contextWindowTokens
    expect(grokSignalsParse(JSON.stringify(o))).toBeNull()
    o.contextWindowTokens = 0
    expect(grokSignalsParse(JSON.stringify(o))).toBeNull()
  })

  it('returns null when the used count is missing or not a number', () => {
    const o = JSON.parse(RAW)
    delete o.contextTokensUsed
    expect(grokSignalsParse(JSON.stringify(o))).toBeNull()
    expect(grokSignalsParse(JSON.stringify({ ...JSON.parse(RAW), contextTokensUsed: '381615' }))).toBeNull()
  })

  it('survives junk without throwing', () => {
    expect(grokSignalsParse('')).toBeNull()
    expect(grokSignalsParse('{ truncated')).toBeNull()
    expect(grokSignalsParse('[]')).toBeNull()
    expect(grokSignalsParse('null')).toBeNull()
  })

  it('reads none of the other 63 keys', () => {
    // A metrics file grows keys. A reader that matched loosely would start reporting whatever gets
    // added next — so changing everything EXCEPT the three must change nothing.
    const o = JSON.parse(RAW)
    const before = grokSignalsParse(RAW)
    for (const k of Object.keys(o)) {
      if (k === 'contextTokensUsed' || k === 'contextWindowTokens' || k === 'contextWindowUsage')
        continue
      o[k] = typeof o[k] === 'number' ? 999999 : typeof o[k] === 'boolean' ? !o[k] : 'CHANGED'
    }
    o.somethingGrokAddsNextRelease = { nested: true }
    const after = grokSignalsParse(JSON.stringify(o))
    expect(after!.used).toBe(before!.used)
    expect(after!.window).toBe(before!.window)
  })
})

describe('grokContextParse — the shape the context tail expects', () => {
  it('matches the dep signature the other agents use', () => {
    expect(grokContextParse(RAW)).toEqual({ used: 381615, window: 500000, model: 'grok-4.6' })
  })

  it('rejoins a line array, because the tail may hand it either', () => {
    expect(grokContextParse(RAW.split('\n'))).toEqual({
      used: 381615,
      window: 500000,
      model: 'grok-4.6'
    })
  })

  it('returns null for a FRAGMENT — why the tail must read the whole file', () => {
    // signals.json is rewritten in place, not appended to. An offset read hands the parser the tail
    // end of a rewritten file, which is not valid JSON. Without `wholeFile`, the meter would fill
    // once and then freeze with nothing to say so.
    expect(grokContextParse(RAW.slice(RAW.length / 2))).toBeNull()
  })
})
