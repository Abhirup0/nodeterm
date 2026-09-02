import { describe, expect, it } from 'vitest'
import { argvHasFlag, shellSingleQuote, shellSplit } from './shell-quote'

describe('shellSingleQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellSingleQuote('fix the bug')).toBe("'fix the bug'")
  })
  it("escapes embedded single quotes", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('shellSplit', () => {
  it('splits on whitespace', () => {
    expect(shellSplit('--model x --api-key foo')).toEqual(['--model', 'x', '--api-key', 'foo'])
  })
  it('preserves quoted substrings as single tokens', () => {
    expect(shellSplit("--msg 'hello world'")).toEqual(['--msg', 'hello world'])
  })
  it('handles double quotes', () => {
    expect(shellSplit('--x "a b" c')).toEqual(['--x', 'a b', 'c'])
  })
  it('honors backslash escapes', () => {
    expect(shellSplit('a\\ b c')).toEqual(['a b', 'c'])
  })
  it('returns [] for empty / whitespace input', () => {
    expect(shellSplit('')).toEqual([])
    expect(shellSplit('   ')).toEqual([])
  })
  it('does NOT perform shell variable expansion ($VAR stays literal)', () => {
    expect(shellSplit('$HOME/x')).toEqual(['$HOME/x'])
  })
})

describe('argvHasFlag', () => {
  it('finds both spellings of an option', () => {
    expect(argvHasFlag('claude --permission-mode plan', '--permission-mode')).toBe(true)
    expect(argvHasFlag('claude --permission-mode=plan', '--permission-mode')).toBe(true)
  })
  it('is false when the flag is absent', () => {
    expect(argvHasFlag('claude --resume abc', '--permission-mode')).toBe(false)
    expect(argvHasFlag('', '--permission-mode')).toBe(false)
  })
  it('does not match a PREFIX of a longer option', () => {
    // `--permission-mode-file` is a different flag; matching it would suppress the real one.
    expect(argvHasFlag('claude --permission-mode-file /x', '--permission-mode')).toBe(false)
  })
  it('does not match the flag inside a quoted argument', () => {
    expect(argvHasFlag("claude -p 'use --permission-mode'", '--permission-mode')).toBe(false)
    expect(argvHasFlag('claude -p "use --permission-mode"', '--permission-mode')).toBe(false)
  })
  it('stops at a bare `--` — past end-of-options a word is data, not an option', () => {
    expect(argvHasFlag('grok -- --permission-mode', '--permission-mode')).toBe(false)
    expect(argvHasFlag('grok --permission-mode plan -- prompt', '--permission-mode')).toBe(true)
  })
})
