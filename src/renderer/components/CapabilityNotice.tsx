import { useProjects } from '../state/projects'
import type { Project } from '@shared/types'
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_COPY,
  projectCapabilityEnabled,
  type ProjectCapability
} from '@shared/project-capabilities'
import { needsCapabilityNotice } from '@shared/project-capability-consent'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * The first capability whose git-shared switch is on for this project while this machine's user
 * has never answered for it. Pure and per-capability so agent messaging's switch (its PR 6) gets
 * this dialog by adding a copy entry — there is nothing per-feature below.
 */
export function pendingCapabilityNotice(p: Project | undefined): ProjectCapability | null {
  if (!p) return null
  for (const cap of PROJECT_CAPABILITIES) {
    const pending = needsCapabilityNotice({
      capability: cap,
      // Strict read: a hand-edited "true"/1/{} is off, so it can never raise (or need) a notice.
      enabledInFile: projectCapabilityEnabled(p, cap),
      acknowledged: p.capabilityAck?.[cap] === true
    })
    if (pending) return cap
  }
  return null
}

/**
 * THE ONE-TIME CLONE NOTICE — the one thing standing between a hostile `.nodeterm/project.json`
 * and a grant, so every property here is security-shaped and test-named:
 *
 *  - It exists because a capability switch is git-shared: a teammate (or a stranger's repo) can
 *    commit `agentBrowserControl: true`, and the user who cloned it was never asked. The warning
 *    at the point of SETTING (Settings → Agents) cannot reach them; this dialog can.
 *  - CLICK-ONLY (`enterConfirms={false}` — confirm-key.ts's rule for dialogs the user did not
 *    open): it was raised by a FILE, and an Enter aimed at a terminal must not answer it.
 *    capability-notice.test.tsx "is CLICK-ONLY" fails if this prop is dropped.
 *  - Once per project EVER, proven by persistence, not by session state: the answer lands in
 *    `Project.capabilityAck` → `IndexEntryV3.capabilityAck` (machine-local), never in the shared
 *    file — "a second open does not re-notify" and workspace-files.test.ts pin both halves.
 *  - While it is unanswered the capability GRANTS NOTHING: every consumer reads
 *    `projectCapabilityGranted`, which refuses a pending notice ("does not grant while
 *    unanswered"). This component never needs to race anyone.
 *
 * Renders against the ACTIVE project (the project-load path re-evaluates it on every switch), so
 * a background project's hostile file cannot pop a dialog about a canvas the user is not looking
 * at — they are told when they actually open it.
 */
export function CapabilityNotice(): React.JSX.Element | null {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const projects = useProjects((s) => s.projects)
  const setProjectCapability = useProjects((s) => s.setProjectCapability)
  const recordProjectCapabilityAck = useProjects((s) => s.recordProjectCapabilityAck)
  const project = projects.find((p) => p.id === activeProjectId)
  const cap = project ? pendingCapabilityNotice(project) : null
  if (!project || !cap) return null
  const copy = PROJECT_CAPABILITY_COPY[cap]
  return (
    <ConfirmDialog
      body={
        <div className="confirm__msg">
          <p>{copy.description}</p>
          <p>{copy.cloneWarning}</p>
        </div>
      }
      message={`The project "${project.name}" arrived with "${copy.label}" already switched on — it came from the project file, not from you. Keep it on?`}
      confirmLabel="Keep it on"
      cancelLabel="Turn it off"
      // "Keep it on" is the grant, so it carries the danger styling and — per ConfirmDialog's
      // rule — never the autofocus; Escape and the overlay click take the safe "Turn it off" path.
      danger
      enterConfirms={false}
      onConfirm={() => recordProjectCapabilityAck(project.id, cap)}
      onCancel={() => {
        // Answered too: the ack makes "once per project ever" true for this entry, and clearing
        // the field means the capability stays a refusal (and the file sheds the stranger's grant
        // on the next save this user makes).
        recordProjectCapabilityAck(project.id, cap)
        setProjectCapability(project.id, cap, false)
      }}
    />
  )
}
