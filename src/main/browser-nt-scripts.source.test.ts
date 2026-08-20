import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { NT_SCRIPTS, isNtScript } from './browser-nt-scripts'

/**
 * A SOURCE-LEVEL test, same enforcement style as hook-verified-parity.test.ts.
 *
 * The residual risk of excluding Runtime.evaluate is that OUR wrapper scripts still run in the
 * page's origin with full authority. A stray template literal, a `new Function`, an innerHTML sink
 * in one of them is a complete escape and hands the agent everything Runtime.evaluate would have.
 * Three things pay that down and they are requirements, not suggestions; this is the second.
 */
const BANNED = ['`', '${', 'eval', 'Function', 'innerHTML', 'outerHTML', 'setTimeout(', 'import(', 'document.cookie', 'localStorage', 'sessionStorage', 'fetch(', 'XMLHttpRequest']

describe('NT_SCRIPTS is a frozen table of literals', () => {
  const src = readFileSync(new URL('./browser-nt-scripts.ts', import.meta.url), 'utf8')

  it.each(BANNED)('the source contains no %s', (needle) => {
    expect(src.includes(needle)).toBe(false)
  })

  it('contains no string concatenation inside the table', () => {
    // `expression: 'document.querySelector("' + sel + '")'` is the injection this whole design
    // exists to make unrepresentable. The selector arrives as arguments[].value, never as source.
    const table = src.slice(src.indexOf('export const NT_SCRIPTS'))
    expect(table).not.toMatch(/'\s*\+|\+\s*'/)
  })

  it('is frozen at runtime, deeply', () => {
    expect(Object.isFrozen(NT_SCRIPTS)).toBe(true)
    expect(() => {
      // @ts-expect-error deliberate
      NT_SCRIPTS.readMap = 'x'
    }).toThrow()
  })

  it('isNtScript is IDENTITY membership, not a shape check', () => {
    expect(isNtScript(NT_SCRIPTS.readMap)).toBe(true)
    expect(isNtScript(NT_SCRIPTS.readMap + ' ')).toBe(false)
    expect(isNtScript('function(){return 1}')).toBe(false)
  })

  it('readMap reports whether a field is FILLED but never returns its value (Task 7.5)', () => {
    // The whole point of `--read map`: a password's fill STATE is useful, its value is a credential.
    // The returned object literal must never carry a `value:` key. Reading `el.value` to compute the
    // boolean is fine (no assignment); RETURNING it is the leak this pins against.
    expect(NT_SCRIPTS.readMap).toContain('filled:')
    expect(NT_SCRIPTS.readMap).not.toMatch(/value\s*:/)
  })

  it('every script is a pure reader — none clicks, navigates, submits or writes', () => {
    // Every EFFECT goes through Input.* or Page.*, which is also why the effects are traceable.
    for (const s of Object.values(NT_SCRIPTS)) {
      for (const bad of ['.click(', '.submit(', 'location =', 'location.href', '.value =', '.remove(']) {
        expect(s.includes(bad), `${bad} in ${s.slice(0, 40)}`).toBe(false)
      }
    }
  })
})
