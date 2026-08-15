import { describe, it, expect } from 'vitest'
import { oneLine } from './one-line'

const LF = '\n'
const CR = '\r'
const VT = '\v'
const FF = '\f'
const ESC = '\x1b'
const NUL = '\0'
// Built from code points on purpose: written out they are invisible in the source, which is
// exactly the property that makes them worth testing.
const NEL = String.fromCodePoint(0x85) // C1 NEXT LINE
const LSEP = String.fromCodePoint(0x2028) // LINE SEPARATOR
const PSEP = String.fromCodePoint(0x2029) // PARAGRAPH SEPARATOR

describe('oneLine', () => {
  it('leaves an ordinary title byte-for-byte — including its double spaces and unicode', () => {
    for (const ok of [
      'My session',
      'refactor  the  parser',
      'ünïcode 🎉 — em dash, "quotes", $(id), `id`',
      'feat/rename-title #42 (wip)'
    ]) {
      expect(oneLine(ok)).toBe(ok)
    }
  })

  it('collapses every submit-capable character to a single space', () => {
    expect(oneLine(`a${LF}b`)).toBe('a b')
    expect(oneLine(`a${CR}b`)).toBe('a b')
    expect(oneLine(`a${CR}${LF}b`)).toBe('a b')
    expect(oneLine(`a${VT}b`)).toBe('a b')
    expect(oneLine(`a${FF}b`)).toBe('a b')
    expect(oneLine(`a${NEL}b`)).toBe('a b')
    expect(oneLine(`a${LSEP}b`)).toBe('a b')
    expect(oneLine(`a${PSEP}b`)).toBe('a b')
  })

  it('also removes the controls that REWRITE a line rather than end it', () => {
    // ctrl-u (kill-line) and ctrl-k need no newline to do damage: they wipe the benign prefix and
    // leave only what follows for the Enter the delivery appends itself. ESC opens a sequence; a
    // raw NUL is what made source files invisible to git and ripgrep here once already.
    expect(oneLine('SAFE\x15rm -rf ~')).toBe('SAFE rm -rf ~')
    expect(oneLine('SAFE\x0brm -rf ~')).toBe('SAFE rm -rf ~')
    expect(oneLine(`x${ESC}[201~y`)).toBe('x [201~y')
    expect(oneLine(`x${NUL}y`)).toBe('x y')
  })

  it('eats the spaces hugging the break, so one break yields exactly one space', () => {
    expect(oneLine(`a  ${LF}  b`)).toBe('a b')
    expect(oneLine(`a${LF}${LF}${LF}b`)).toBe('a b')
    expect(oneLine(`a${CR}${LF} ${CR}${LF}b`)).toBe('a b')
  })

  it('drops a leading/trailing break entirely — a title does not end in whitespace', () => {
    expect(oneLine(`${LF}Deploy${CR}`)).toBe('Deploy')
    expect(oneLine('  Deploy  ')).toBe('Deploy')
  })

  it('is idempotent', () => {
    const once = oneLine(`a${LF}b${CR}c`)
    expect(oneLine(once)).toBe(once)
  })

  it('never returns a string containing a member of the class — the whole invariant, exhaustively', () => {
    // Every C0 code point, DEL, and every C1 code point, each planted mid-title.
    const points = [
      ...Array.from({ length: 0x20 }, (_, i) => i),
      0x7f,
      ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
      0x2028,
      0x2029
    ]
    for (const cp of points) {
      const out = oneLine(`before${String.fromCodePoint(cp)}after`)
      expect(out, `U+${cp.toString(16)} survived`).toBe('before after')
    }
  })
})
