// The control verbs whose `Canvas.tsx` dispatch case is confirm-gated AND says so through this
// set. Read the second half of that sentence literally — see WHAT THIS SET DOES NOT DO below.
//
// IN `src/shared` BECAUSE IT HAS TWO SIDES, and that is the whole point of this file existing.
// The set was defined in `src/main/canvas-control-core.ts` and the gate it describes lives in the
// renderer (`Canvas.tsx`'s `switch (verb)`), which cannot import from `src/main` — `tsconfig.web`
// includes only `src/renderer`, `src/shared` and the preload types. So the set stayed a
// security-shaped constant imported by nothing but its own unit test, while
// `TOLERANT_CONTROL_VERBS`' doc comment, `hook-server.ts`'s `buildPtyEnv` note and
// `docs/node-identity.md:65` all named it as "the confirm-gated set". It described the dispatch;
// it did not decide it. Adding a verb to it changed nothing.
//
// WHAT THIS SET DOES NOT DO — and the reason this paragraph exists is that the defect above was a
// comment claiming a mechanism that was not there:
//
//   Adding a verb here does NOT gate it. Measured: adding `'restart'` produces no dialog at all.
//   Every case still hand-writes its own `setConfirm({ … })`, and this set is only read for the
//   `confirmBusy()` refusal that precedes it. A newly added verb still needs its own confirm
//   block, written by hand, in its own case.
//
//   What both sides reading one set buys is a DRIFT ALARM, not a gate:
//   `src/renderer/canvas/control-destructive.test.ts` fails if the set and the hand-written
//   confirm cases stop agreeing in either direction. That is worth having — the set and the
//   dispatch had already drifted once, which is how it came to gate nothing — but it is an alarm,
//   and calling it a gate would repeat the exact mistake this file was created to fix.
//
// NOR IS IT THE COMPLETE LIST OF CONFIRM-GATED ACTIONS. `close-worktree --mode remove`
// (`Canvas.tsx`'s `case 'close-worktree'`) opens a human confirm through `requestRemoveWorktree`,
// which carries its own `confirmBusy()` refusal, and it is deliberately NOT in this set: its gate
// is the pre-existing worktree-removal dialog, reached by a different route, and widening the set
// to cover it would change its refusal path for no benefit. Anyone auditing "what asks the human
// first" must read the dispatch, not only this set.
//
// Typed on `string`, not `ControlVerb`: that type belongs to the main-side verb model, which is
// exactly what the renderer cannot see, and the renderer's dispatch receives a raw `verb: string`
// off IPC anyway. `canvas-control-core.ts` re-exports this so main-side callers are unchanged.

// `open-project` (issue #338): create/adopt/first-attach all raise a human confirm (spec B2 +
// Q1), and its early-handled block in Canvas.tsx reads `isDestructiveVerb(verb)` before its
// `confirmBusy()` refusal exactly as write/close's cases do — the drift alarm covers all three.
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set(['write', 'close', 'open-project'])

/**
 * Does this verb's dispatch case take its `confirmBusy()` refusal from the shared set?
 *
 * NOT "is a human asked about this verb" — `close-worktree --mode remove` is confirmed by a human
 * and answers `false` here (see the file header). And not "is this verb gated": the dialog itself
 * is hand-written per case, so this returning `true` for a new verb would gate nothing on its own.
 *
 * `open-terminal --cmd` is deliberately NOT in the set and never was; the 2026-08-13 argv-leak
 * writeup in `docs/node-identity.md` is the record of what that costs when the bearer leaks.
 */
export function isDestructiveVerb(verb: string): boolean {
  return DESTRUCTIVE_VERBS.has(verb)
}
