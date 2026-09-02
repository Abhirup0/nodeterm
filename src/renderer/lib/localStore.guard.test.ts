// One rule, invisible for the life of the project: nothing outside `lib/localStore.ts` decides for
// itself whether `localStorage` is usable.
//
// Five files did, all with `typeof localStorage === 'undefined'`, and every one of them read
// correctly to a reviewer — on a browser it IS correct. What it cannot see is a global that exists
// with no methods, which is what recent Node hands you unless `--localstorage-file` is passed. Three
// of the five read at module level to seed a store, so the TypeError fired on IMPORT and took twelve
// renderer suites down at once, none of them named after the store that failed (#412).
//
// So the rule is enforced by scan rather than by memory: a store added next year gets the working
// check because this test refuses the alternative, not because its author read #412.
//
// Deliberately NOT "must import localStore": the try/catch-only sites (`state/explorer.ts`,
// `state/presence.ts`, `state/agentStatus.ts` and friends) are already safe — the method-missing
// TypeError lands in their catch. The hazard is the typeof guard specifically, because it is the
// one spelling that looks like a check and answers the wrong question.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SOURCE_ROOT = join(__dirname, '..', '..')
const ROOTS = [join(SOURCE_ROOT, 'renderer')]

/** Guard comparisons use one separator regardless of the host running Vitest. */
function normalizedSourcePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function sourceRelativePath(file: string): string {
  return normalizedSourcePath(relative(SOURCE_ROOT, file))
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') sources(p, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

/**
 * Files allowed to test the `localStorage` global directly, each with the reason.
 *
 * Kept deliberately short. An entry here means "the check belongs here", not "nobody got round to
 * it yet" — the latter belongs in an issue.
 */
const GUARD_ALLOWED = new Map<string, string>([
  ['renderer/lib/localStore.ts', 'the helper; this is where the one real check lives']
])

function isGuardAllowed(relativeFile: string): boolean {
  return GUARD_ALLOWED.has(normalizedSourcePath(relativeFile))
}

/**
 * Every spelling of "ask whether the global exists" — the question that cannot distinguish a
 * method-less global from a working one. Comments are stripped first: this file and `localStore.ts`
 * both discuss the banned pattern in prose, and a guard that flags its own explanation trains people
 * to add exemptions.
 */
function typeofGuardHits(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return [
    ...code.matchAll(
      /typeof\s*\(?\s*(?:(?:globalThis|window|self)\s*(?:\.\s*|\[\s*['"]))?localStorage\b/g
    )
  ].map((m) => m[0].replace(/\s+/g, ' '))
}

describe('only localStore.ts decides whether localStorage is usable', () => {
  const files = ROOTS.flatMap((r) => sources(r))

  it('finds the source tree (a zero-file scan would pass silently)', () => {
    // The failure mode this whole file guards against, one level up: a scan matching nothing
    // reports clean. If a directory moves and this drops to nothing, it must go red, not quiet.
    expect(files.length).toBeGreaterThan(100)
  })

  it('no bare typeof-localStorage guard outside the helper', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = sourceRelativePath(f)
      if (isGuardAllowed(rel)) continue
      const hits = typeofGuardHits(readFileSync(f, 'utf8'))
      if (hits.length) offenders.push(`${rel}  [${hits.join(', ')}]`)
    }
    expect(
      offenders,
      'these ask whether the localStorage global EXISTS, which is true for the method-less global ' +
        'recent Node provides — the next call then throws. Use readLocal/writeLocal/localStoreUsable ' +
        'from renderer/lib/localStore.ts'
    ).toEqual([])
  })

  it('the guard would actually catch each spelling', () => {
    // Proving the needle bites, on strings rather than by breaking real files.
    expect(typeofGuardHits("if (typeof localStorage === 'undefined') return null")).not.toEqual([])
    expect(typeofGuardHits("if (typeof localStorage !== 'undefined') save(v)")).not.toEqual([])
    expect(typeofGuardHits('typeof  localStorage  === "undefined"')).not.toEqual([])
    expect(typeofGuardHits("typeof window.localStorage === 'undefined'")).not.toEqual([])
    expect(typeofGuardHits("typeof globalThis.localStorage === 'undefined'")).not.toEqual([])
    // Parenthesised and bracket spellings: the first version of this needle knew only the bare
    // identifier, which is exactly how a guard turns "nobody checked" into "this was checked".
    expect(typeofGuardHits("typeof(localStorage) === 'undefined'")).not.toEqual([])
    expect(typeofGuardHits("typeof (localStorage) === 'undefined'")).not.toEqual([])
    expect(typeofGuardHits("typeof globalThis['localStorage'] === 'undefined'")).not.toEqual([])
    expect(typeofGuardHits('typeof window["localStorage"] === "undefined"')).not.toEqual([])
    // …and does NOT flag the replacements, nor a name that merely contains it.
    expect(typeofGuardHits("readLocal('k') === '1'")).toEqual([])
    expect(typeofGuardHits('if (!localStoreUsable()) return true')).toEqual([])
    expect(typeofGuardHits("typeof localStorageMirror === 'undefined'")).toEqual([])
    expect(typeofGuardHits("typeof myLocalStorage === 'undefined'")).toEqual([])
    expect(typeofGuardHits("typeof sessionStorage === 'undefined'")).toEqual([])
    // The prose exemption: discussion in comments is not an offence, or this file fails itself.
    expect(typeofGuardHits("// typeof localStorage === 'undefined' was the old guard")).toEqual([])
    expect(typeofGuardHits("/* typeof localStorage is not enough */")).toEqual([])
  })

  it('normalizes the helper exemption on both POSIX and Windows-shaped paths', () => {
    expect(isGuardAllowed('renderer/lib/localStore.ts')).toBe(true)
    expect(isGuardAllowed(String.raw`renderer\lib\localStore.ts`)).toBe(true)
    expect(isGuardAllowed('renderer/lib/localStore.ts.bak')).toBe(false)
    expect(isGuardAllowed('nested/renderer/lib/localStore.ts')).toBe(false)
    const scanned = new Set(files.map(sourceRelativePath))
    for (const allowed of GUARD_ALLOWED.keys()) expect(scanned.has(allowed)).toBe(true)
  })
})
