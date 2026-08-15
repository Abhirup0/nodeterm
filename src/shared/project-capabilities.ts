/**
 * Per-project capability switches — the FIRST of their kind in nodeterm.
 *
 * Before this file, `Project` carried exactly two policy fields (defaultAccountId,
 * defaultPermissionMode) and there was no per-project settings surface at all. Browser control
 * needed one and agent-to-agent messaging needs the same one, so the mechanism lives here ONCE:
 * the key set, the copy, the strict read, and the file round-trip. Adding a capability is a line in
 * PROJECT_CAPABILITIES plus an entry in PROJECT_CAPABILITY_COPY — no persistence code changes and,
 * critically, no second clone-notice implementation (see core/project-capability-consent.ts).
 *
 * THESE FIELDS LIVE IN .nodeterm/project.json, WHICH IS GIT-SHARED. That is a hazard to be handled,
 * not noted: a hostile cloned repo ships `agentBrowserControl: true` and the clone's first agent
 * turn would otherwise hold the capability. Two things make that survivable and BOTH are required:
 *
 *  1. The switch alone grants nothing. Every capability must additionally require state this app
 *     run built and never persisted (browser control: the in-memory ownership ledger; a cloned
 *     project.json cannot pre-populate it, and `Project.ropes` — which IS persisted and git-shared —
 *     is deliberately never consulted for ownership).
 *  2. First use in a project the user has not personally switched on raises a one-time notice,
 *     recorded MACHINE-LOCALLY (IndexEntryV3.capabilityAck), never in project.json.
 *
 * If (2) is ever dropped as friction, this field must move to a machine-local store. That is the
 * trigger, written down where the decision is, not only in the design doc.
 */
export type ProjectCapability = 'agentBrowserControl'
// Agent-to-agent messaging adds 'agentMessaging' here (its plan's PR 6 Task 6.1).

export const PROJECT_CAPABILITIES: readonly ProjectCapability[] = ['agentBrowserControl'] as const

export interface ProjectCapabilityCopy {
  label: string
  description: string
  /** Shown wherever the switch is set AND in the clone notice. Same wording class as TabBar's
   *  bypassPermissions title, so the two git-shared grants read alike. */
  cloneWarning: string
}

export const PROJECT_CAPABILITY_COPY: Record<ProjectCapability, ProjectCapabilityCopy> = {
  agentBrowserControl: {
    label: 'Let agents drive browser nodes they open',
    description:
      'Agents in this project can navigate, read, click and type in browser nodes THEY opened — ' +
      'never in browser nodes you opened. Any page an agent reads can try to steer it: a page can ' +
      'contain instructions, and the same agent can navigate anywhere and type anywhere. Nodes an ' +
      'agent opens use their own logged-out session, separate from your own browsing. A badge on ' +
      'the node shows when one is being driven, with a Stop button.',
    cloneWarning:
      'This setting is saved in the project file (.nodeterm/project.json), so if you commit it, ' +
      'everyone who clones the repo gets it too.'
  }
}

/** Is this capability on for this project? STRICT `=== true`: .nodeterm/project.json is hostile
 *  input — git-shared, hand-editable, auto-adopted (@shared/node-exec) — so `"true"`, `1` and `{}`
 *  are off. Every consumption site goes through this function; a bare `if (project.x)` is a bug.
 *  (`project-capabilities.test.ts` fails on any of those values enabling.) */
export function projectCapabilityEnabled(
  p: Partial<Record<ProjectCapability, unknown>> | undefined | null,
  cap: ProjectCapability
): boolean {
  return p?.[cap] === true
}

/** The capability half of a ProjectFileV1, normalised: known keys only, literal `true` only. */
export function readProjectCapabilities(f: unknown): Partial<Record<ProjectCapability, true>> {
  const out: Partial<Record<ProjectCapability, true>> = {}
  if (!f || typeof f !== 'object') return out
  for (const cap of PROJECT_CAPABILITIES) {
    if ((f as Record<string, unknown>)[cap] === true) out[cap] = true
  }
  return out
}

/** The spread `projectToFile` uses. Absent keys are omitted, so an off capability adds no bytes to
 *  the committed file and no churn to anyone's git diff. */
export function projectCapabilityFields(
  p: Partial<Record<ProjectCapability, unknown>> | undefined | null
): Partial<Record<ProjectCapability, true>> {
  return readProjectCapabilities(p ?? {})
}
