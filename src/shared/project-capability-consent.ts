/**
 * The one-time clone notice, decided ONCE for every capability — pure, shared, and the only
 * decider either feature may use (browser control here in PR 3; agent messaging adopts it in its
 * PR 6 without reimplementing anything).
 *
 * A switch that arrives from a clone is not the same thing as a switch the user set:
 * `.nodeterm/project.json` is git-shared and hand-editable, so `agentBrowserControl: true` in a
 * freshly cloned repo is a stranger's decision until this machine's user has seen it. The
 * acknowledgment is therefore recorded MACHINE-LOCALLY (`IndexEntryV3.capabilityAck` — the index
 * entry is the only authority for project identity), never in the shared file; a second worktree
 * of the same repo is a second entry, hence a second notice, on purpose.
 *
 * Lives in `src/shared` for the same reason as `safe-id.ts`: the renderer raises the dialog and may
 * not import `src/core`; `core/project-capability-consent.ts` re-exports these for main/core
 * callers, and its test pins that the two paths are the same function objects.
 */
import type { ProjectCapability } from './project-capabilities'

/** The machine-local ack record, keyed like the capability fields but never written to the shared
 *  project file (`projectToFile` does not know this shape exists — pinned by the consent test). */
export type CapabilityAckMap = Partial<Record<ProjectCapability, true>>

export interface CapabilityConsentState {
  capability: ProjectCapability
  /** The strict read of the shared file's switch (`projectCapabilityEnabled` — literal true only). */
  enabledInFile: boolean
  /** Has THIS MACHINE's user answered the notice for this project entry (or personally set the
   *  switch, which is its own acknowledgment)? */
  acknowledged: boolean
}

/** On in the file + never acknowledged on this machine ⇒ notice. Everything else is silence:
 *  off needs no warning, and an answered notice is answered forever (per index entry). */
export function needsCapabilityNotice(s: CapabilityConsentState): boolean {
  return s.enabledInFile === true && s.acknowledged !== true
}

/**
 * May the capability act RIGHT NOW? A pending notice is a refusal, not a grant: the window between
 * a hostile clone's `agentBrowserControl: true` arriving and the user answering the notice must
 * refuse (`project-capability-consent.test.ts` — "a switch that is on but unanswered grants
 * nothing"). This is the predicate the browser ledger's admission check (PR 4) and messaging's
 * `messagingEnabled` wiring (PR 6) consult per call — never cached at lease start.
 */
export function projectCapabilityGranted(s: CapabilityConsentState): boolean {
  return s.enabledInFile === true && !needsCapabilityNotice(s)
}

/**
 * Returns `entry` with the capability acknowledged — a new object, input untouched. Works on any
 * entry-shaped record (`IndexEntryV3` in main, the renderer's `Project` mirror of the same
 * machine-local field) so both sides record the ack through the one function.
 */
export function recordCapabilityAck<E extends { capabilityAck?: CapabilityAckMap }>(
  entry: E,
  cap: ProjectCapability
): E {
  return { ...entry, capabilityAck: { ...entry.capabilityAck, [cap]: true } }
}
