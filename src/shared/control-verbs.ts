// The control verbs that must not act until a human has said yes in a dialog.
//
// IN `src/shared` BECAUSE IT HAS TWO SIDES, and that is the whole point of this file existing.
// The set was defined in `src/main/canvas-control-core.ts` and the gate it describes lives in the
// renderer (`Canvas.tsx`'s `switch (verb)`), which cannot import from `src/main` — `tsconfig.web`
// includes only `src/renderer`, `src/shared` and the preload types. So the set stayed a
// security-shaped constant imported by nothing but its own unit test, while
// `TOLERANT_CONTROL_VERBS`' doc comment, `hook-server.ts`'s `buildPtyEnv` note and
// `docs/node-identity.md` (twice, including invariant 6) all described it as "the confirm-gated
// set". It described the dispatch; it did not decide it. Adding a verb to it changed nothing.
//
// Here, both sides can read the same set, so adding a verb GATES that verb.
//
// Typed on `string`, not `ControlVerb`: that type belongs to the main-side verb model, which is
// exactly what the renderer cannot see, and the renderer's dispatch receives a raw `verb: string`
// off IPC anyway. `canvas-control-core.ts` re-exports this so main-side callers are unchanged.

export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set(['write', 'close'])

/**
 * Is this verb one the human must confirm before it acts?
 *
 * `open-terminal --cmd` is deliberately NOT in the set and never was; the 2026-08-13 argv-leak
 * writeup in `docs/node-identity.md` is the record of what that costs when the bearer leaks.
 */
export function isDestructiveVerb(verb: string): boolean {
  return DESTRUCTIVE_VERBS.has(verb)
}
