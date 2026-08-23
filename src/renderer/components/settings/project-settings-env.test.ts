import { describe, expect, it } from 'vitest'
import { formatEnvLines, formatListLines, parseEnvLines, parseListLines } from './project-settings-env'

describe('parseEnvLines / formatEnvLines', () => {
  it('parses KEY=VALUE lines, reports rejects, round-trips', () => {
    const r = parseEnvLines('FOO=bar\nbad key=1\n\nBAZ=a=b')
    expect(r.env).toEqual({ FOO: 'bar', BAZ: 'a=b' })
    expect(r.rejected).toEqual(['bad key=1'])
    expect(parseEnvLines(formatEnvLines(r.env)).env).toEqual(r.env)
  })

  it('rejects a line with no "=" and a __proto__ key, keeping the rest', () => {
    const r = parseEnvLines('nope\n__proto__=x\nFOO=1')
    expect(r.env).toEqual({ FOO: '1' })
    expect(r.rejected).toEqual(['nope', '__proto__=x'])
  })

  it('rejects a key with invalid characters (mirrors the shared sanitizer)', () => {
    const r = parseEnvLines('1BAD=x\nGOOD_1=y')
    expect(r.env).toEqual({ GOOD_1: 'y' })
    expect(r.rejected).toEqual(['1BAD=x'])
  })

  it('is CRLF-aware and skips blank lines', () => {
    const r = parseEnvLines('A=1\r\n\r\nB=2\r\n')
    expect(r.env).toEqual({ A: '1', B: '2' })
    expect(r.rejected).toEqual([])
  })

  it('formats an env object as sorted KEY=VALUE lines, and undefined as empty', () => {
    expect(formatEnvLines({ B: '2', A: '1' })).toBe('A=1\nB=2')
    expect(formatEnvLines(undefined)).toBe('')
    expect(formatEnvLines({})).toBe('')
  })
})

describe('parseListLines / formatListLines', () => {
  it('trims each line and drops empties', () => {
    expect(parseListLines(' a \n\nb\r\nc \n  \n')).toEqual(['a', 'b', 'c'])
  })

  it('formats items one per line, and undefined as empty', () => {
    expect(formatListLines(['a', 'b'])).toBe('a\nb')
    expect(formatListLines(undefined)).toBe('')
    expect(formatListLines([])).toBe('')
  })
})
