import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isDestructiveVerb, DESTRUCTIVE_VERBS } from '@shared/control-verbs'

/**
 * A STRUCTURAL test on purpose.
 *
 * `DESTRUCTIVE` / `isDestructiveVerb` named `write` and `close` as "the confirm-gated set" and was
 * imported by nothing but its own unit test — it could not be anything else, because it lived in
 * `src/main` and the gate is in the renderer, which cannot import from there. The live gate was a
 * hand-written `if (confirmBusy())` inside each of the two `switch (verb)` cases, so the SET gated
 * nothing: adding a verb to it changed no behaviour, while `TOLERANT_CONTROL_VERBS`' doc comment,
 * `hook-server.ts`'s `buildPtyEnv` note and `docs/node-identity.md` (twice, including invariant 6)
 * all tell a reader that the set is what decides.
 *
 * The dispatch now reads the set. There is no unit seam to assert that through — the switch lives
 * inside a 7000-line React component's IPC listener — and the failure mode being pinned is exactly
 * "a reader trusts the constant", which is a property of the SOURCE. So the source is the subject.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

/** The body of one `case '<verb>': {` in the control dispatch, up to the next case label. */
function caseBody(verb: string): string {
  const start = src.indexOf(`case '${verb}': {`)
  if (start === -1) return ''
  const rest = src.slice(start + verb.length + 10)
  const end = rest.search(/\n {10}case '/)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('destructive verbs are confirm-gated through the shared set', () => {
  it('the dispatch imports the set rather than restating it', () => {
    expect(src).toMatch(/import \{[^}]*isDestructiveVerb[^}]*\} from '@shared\/control-verbs'/)
  })

  for (const verb of ['write', 'close'] as const) {
    it(`${verb} reaches its confirm through isDestructiveVerb`, () => {
      expect(isDestructiveVerb(verb)).toBe(true)
      const body = caseBody(verb)
      expect(body).not.toBe('')
      // The guard CALL, not a hardcoded truth: adding a verb to the set must change behaviour.
      expect(body).toMatch(/isDestructiveVerb\(verb\) && confirmBusy\(\)/)
      // …and no leftover bare gate beside it, which would make the set decorative again.
      expect(body).not.toMatch(/\bif \(confirmBusy\(\)\)/)
      expect(body).toContain('setConfirm({')
    })
  }

  it('no OTHER verb is silently confirm-gated behind the set', () => {
    // Every `isDestructiveVerb(verb)` in the dispatch must sit in a case the set actually holds.
    // If a third case ever grows one, either the set or the dispatch is wrong — say so here rather
    // than let the two drift apart the way the constant and the switch already did once.
    const labels = [...src.matchAll(/\n {10}case '([a-z-]+)': \{/g)].map((m) => m[1])
    const gated = labels.filter((v) => /isDestructiveVerb\(verb\)/.test(caseBody(v)))
    expect(new Set(gated)).toEqual(new Set(DESTRUCTIVE_VERBS))
  })
})
