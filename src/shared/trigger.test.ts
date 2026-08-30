import { describe, expect, it } from 'vitest'
import {
  TRIGGER_INTERVAL_MAX_MINUTES,
  TRIGGER_NOTE_MAX,
  TRIGGER_PAYLOAD_MAX,
  canonicalTriggerSpec,
  sanitizeTriggerSpec,
  type TriggerSpec
} from './trigger'

const valid = (): TriggerSpec => ({
  schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
  payload: 'npm run report',
  target: 'term-abc123-1'
})

describe('sanitizeTriggerSpec', () => {
  it('accepts a valid cron spec and rebuilds it with only the known fields', () => {
    const out = sanitizeTriggerSpec({ ...valid(), armed: true, extra: { deep: 1 } })
    expect(out).toEqual(valid())
    // The rebuild is the smuggling defense: an `armed` (or any unknown) key from a hostile file
    // must not survive a load/save round trip.
    expect(Object.keys(out!)).toEqual(['schedule', 'payload', 'target'])
    expect(Object.keys(out!.schedule)).toEqual(['kind', 'expr'])
  })

  it('accepts interval and once schedules', () => {
    expect(
      sanitizeTriggerSpec({ ...valid(), schedule: { kind: 'interval', everyMinutes: 30 } })
    ).toEqual({ ...valid(), schedule: { kind: 'interval', everyMinutes: 30 } })
    expect(
      sanitizeTriggerSpec({ ...valid(), schedule: { kind: 'once', at: '2026-09-01T09:00:00Z' } })
    ).toEqual({ ...valid(), schedule: { kind: 'once', at: '2026-09-01T09:00:00Z' } })
  })

  it('keeps a valid note and drops an invalid one without refusing the spec', () => {
    expect(sanitizeTriggerSpec({ ...valid(), note: 'daily report' })).toEqual({
      ...valid(),
      note: 'daily report'
    })
    expect(sanitizeTriggerSpec({ ...valid(), note: 42 })).toEqual(valid())
    expect(sanitizeTriggerSpec({ ...valid(), note: 'x'.repeat(TRIGGER_NOTE_MAX + 1) })).toEqual(
      valid()
    )
  })

  it('refuses non-objects and missing parts', () => {
    expect(sanitizeTriggerSpec(undefined)).toBeUndefined()
    expect(sanitizeTriggerSpec(null)).toBeUndefined()
    expect(sanitizeTriggerSpec('cron')).toBeUndefined()
    expect(sanitizeTriggerSpec({})).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), schedule: undefined })).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), payload: undefined })).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), target: undefined })).toBeUndefined()
  })

  it('refuses malformed schedules', () => {
    const withSchedule = (schedule: unknown) => sanitizeTriggerSpec({ ...valid(), schedule })
    expect(withSchedule({ kind: 'cron', expr: '' })).toBeUndefined()
    expect(withSchedule({ kind: 'cron', expr: 42 })).toBeUndefined()
    expect(withSchedule({ kind: 'cron', expr: 'x'.repeat(257) })).toBeUndefined()
    expect(withSchedule({ kind: 'cron', expr: '0 9 * * *\u001b[2J' })).toBeUndefined()
    expect(withSchedule({ kind: 'interval', everyMinutes: 0 })).toBeUndefined()
    expect(withSchedule({ kind: 'interval', everyMinutes: 1.5 })).toBeUndefined()
    expect(withSchedule({ kind: 'interval', everyMinutes: -5 })).toBeUndefined()
    expect(
      withSchedule({ kind: 'interval', everyMinutes: TRIGGER_INTERVAL_MAX_MINUTES + 1 })
    ).toBeUndefined()
    expect(withSchedule({ kind: 'once', at: 'not-a-date' })).toBeUndefined()
    expect(withSchedule({ kind: 'once', at: '' })).toBeUndefined()
    expect(withSchedule({ kind: 'constructor' })).toBeUndefined()
    expect(withSchedule({ kind: 'weekly' })).toBeUndefined()
  })

  it('refuses payloads that are empty, oversized, or carry control bytes', () => {
    expect(sanitizeTriggerSpec({ ...valid(), payload: '' })).toBeUndefined()
    expect(
      sanitizeTriggerSpec({ ...valid(), payload: 'x'.repeat(TRIGGER_PAYLOAD_MAX + 1) })
    ).toBeUndefined()
    // Raw ESC — the bracketed-paste-escape injection class. Refused whole, never stripped.
    expect(sanitizeTriggerSpec({ ...valid(), payload: 'echo hi\u001b[201~rm -rf /' })).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), payload: 'a\u0000b' })).toBeUndefined()
    // Multi-line (\n, \t, \r) is legitimate — the paste path frames it.
    expect(sanitizeTriggerSpec({ ...valid(), payload: 'line1\n\tline2\r\n' })).toBeDefined()
  })

  it('refuses targets that are not safe node ids', () => {
    expect(sanitizeTriggerSpec({ ...valid(), target: '' })).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), target: 'a; rm -rf /' })).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), target: '..' })).toBeUndefined()
    expect(sanitizeTriggerSpec({ ...valid(), target: 'x'.repeat(200) })).toBeUndefined()
  })
})

describe('canonicalTriggerSpec', () => {
  it('is independent of input key order', () => {
    const a = sanitizeTriggerSpec({
      target: 'term-a-1',
      payload: 'p',
      schedule: { expr: '* * * * *', kind: 'cron' }
    })!
    const b = sanitizeTriggerSpec({
      schedule: { kind: 'cron', expr: '* * * * *' },
      payload: 'p',
      target: 'term-a-1'
    })!
    expect(canonicalTriggerSpec(a)).toBe(canonicalTriggerSpec(b))
  })

  it('changes when any bound field changes', () => {
    const base = canonicalTriggerSpec(valid())
    expect(canonicalTriggerSpec({ ...valid(), payload: 'npm run report2' })).not.toBe(base)
    expect(canonicalTriggerSpec({ ...valid(), target: 'term-abc123-2' })).not.toBe(base)
    expect(
      canonicalTriggerSpec({ ...valid(), schedule: { kind: 'cron', expr: '0 8 * * 1-5' } })
    ).not.toBe(base)
  })
})
