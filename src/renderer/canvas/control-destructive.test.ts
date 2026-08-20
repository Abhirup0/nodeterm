import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isDestructiveVerb, DESTRUCTIVE_VERBS } from '@shared/control-verbs'

/**
 * A STRUCTURAL test on purpose.
 *
 * `DESTRUCTIVE` / `isDestructiveVerb` named `write` and `close` as "the confirm-gated set" and was
 * read by nothing but its own unit test — it could not be anything else, because it lived in
 * `src/main` and the dispatch is in the renderer, which cannot import from there. The refusal was
 * a hand-written `if (confirmBusy())` inside each of the two `switch (verb)` cases, so the SET
 * decided nothing, while `TOLERANT_CONTROL_VERBS`' doc comment, `hook-server.ts`'s `buildPtyEnv`
 * note and `docs/node-identity.md:65` all name it as what decides.
 *
 * WHAT THIS FILE IS: a drift alarm, not proof of a gate. The dialog is still hand-written in each
 * case, so these assertions cannot show that a verb IS confirmed — only that the set and the cases
 * that read it still agree, in both directions. That is the thing that had already broken once.
 * `close-worktree --mode remove` is confirmed by a human through `requestRemoveWorktree` and is
 * deliberately outside the set, so it is invisible here by design.
 *
 * Structural because there is no unit seam — the switch lives inside a 7000-line React component's
 * IPC listener — and because the failure mode being pinned is exactly "a reader trusts the
 * constant", which is a property of the SOURCE. So the source is the subject.
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

/**
 * The body of an EARLY-HANDLED verb's block — `open-project` is dispatched before the
 * source-routing machinery (a STORE_ANSWERED_VERBS member, spec §2.3), so it has no `case` label.
 * Delimited by its `if (verb === '<verb>')` guard and the next section-comment rule (`// ──`),
 * the same way the switch slice above is delimited by the next case label.
 */
function earlyBody(verb: string): string {
  const start = src.indexOf(`if (verb === '${verb}')`)
  if (start === -1) return ''
  const rest = src.slice(start)
  const end = rest.indexOf('// ──', 10)
  return end === -1 ? rest : rest.slice(0, end)
}

/** A verb's dispatch body wherever it lives: its switch case, or its early-handled block. */
function dispatchBody(verb: string): string {
  return caseBody(verb) || earlyBody(verb)
}

describe('the confirm-gated set and the dispatch that reads it stay in agreement', () => {
  it('the dispatch imports the set rather than restating it', () => {
    expect(src).toMatch(/import \{[^}]*isDestructiveVerb[^}]*\} from '@shared\/control-verbs'/)
  })

  for (const verb of ['write', 'close', 'open-project'] as const) {
    it(`${verb} reaches its confirm through isDestructiveVerb`, () => {
      expect(isDestructiveVerb(verb)).toBe(true)
      const body = dispatchBody(verb)
      expect(body).not.toBe('')
      // The guard CALL, not a hardcoded truth: adding a verb to the set must change behaviour.
      expect(body).toMatch(/isDestructiveVerb\(verb\) && confirmBusy\(\)/)
      // …and no leftover bare gate beside it, which would make the set decorative again.
      expect(body).not.toMatch(/\bif \(confirmBusy\(\)\)/)
      expect(body).toContain('setConfirm({')
      // Denial is honored on every confirm this set gates (spec P4): the cancel leg replies the
      // shared refusal instead of hanging the CLI to its 120s timeout.
      expect(body).toContain("'denied by user'")
    })
  }

  it('no other case reads isDestructiveVerb', () => {
    // Every `isDestructiveVerb(verb)` in the dispatch must sit in a case the set actually holds.
    // If a third case ever grows one, either the set or the dispatch is wrong — say so here rather
    // than let the two drift apart the way the constant and the switch already did once.
    //
    // This scans for the CALL, so a hand-written confirm that never reads the set is invisible to
    // it — `close-worktree --mode remove` is exactly that, on purpose. This is not "no other verb
    // is confirm-gated"; it is "no other case claims to be gated by this set".
    const labels = [...src.matchAll(/\n {10}case '([a-z-]+)': \{/g)].map((m) => m[1])
    const gated = labels.filter((v) => /isDestructiveVerb\(verb\)/.test(caseBody(v)))
    // The early-handled block (`open-project`) is counted the same way, off its own slice.
    for (const early of ['open-project']) {
      if (/isDestructiveVerb\(verb\)/.test(earlyBody(early))) gated.push(early)
    }
    expect(new Set(gated)).toEqual(new Set(DESTRUCTIVE_VERBS))
  })
})
