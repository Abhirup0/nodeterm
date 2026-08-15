import { useState } from 'react'
import { useProjects } from '../state/projects'
import type { Project } from '@shared/types'
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_COPY,
  projectCapabilityFlagInFile,
  type ProjectCapability
} from '@shared/project-capabilities'
import { capabilityAnswerOf, needsCapabilityNotice } from '@shared/project-capability-consent'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * The first capability whose git-shared switch is on for this project while this machine's user
 * has not KEPT it — never answered, or previously DECLINED and the file's `true` re-arrived via
 * git (C1: a recorded "no" makes a re-appearing switch a new event, not a settled one). Pure and
 * per-capability so agent messaging's switch (its PR 6) gets this dialog by adding a copy entry —
 * there is nothing per-feature below.
 */
export function pendingCapabilityNotice(p: Project | undefined): ProjectCapability | null {
  if (!p) return null
  for (const cap of PROJECT_CAPABILITIES) {
    const pending = needsCapabilityNotice({
      capability: cap,
      // Strict read: a hand-edited "true"/1/{} is off, so it can never raise (or need) a notice.
      enabledInFile: projectCapabilityFlagInFile(p, cap),
      answer: capabilityAnswerOf(p, cap)
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
 *  - ONLY THE TWO BUTTONS ARE ANSWERS (PR #213 review, I1). "Keep it on" records 'kept'; "Turn it
 *    off" records 'declined' and sheds the field. Escape, an overlay misclick, and a keystroke
 *    aimed at a terminal are NON-answers: `enterConfirms={false}` blocks the window-listener path,
 *    `autoFocusButtons={false}` means no button holds focus for a native Enter/Space to activate,
 *    and `onDismiss` closes the dialog for this app session without recording anything — it
 *    re-shows on the next launch (capability-notice.test.tsx "dismissal is not an answer").
 *  - The answers are machine-local and carry WHICH answer was given: `Project.capabilityAck` →
 *    `IndexEntryV3.capabilityAck`, never the shared file. 'kept' silences the notice for this
 *    entry forever; 'declined' + a re-arriving `true` re-notices AND stays refused (C1) — a
 *    routine `git checkout` restoring the hostile flag can never convert a "no" into a grant.
 *  - While it is unanswered (or declined) the capability GRANTS NOTHING: every consumer reads
 *    `projectCapabilityGrantedFor`, which requires the recorded 'kept' ("does not grant while
 *    unanswered", "a DECLINED switch grants nothing even when the file says true again").
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
  // Dismissed-this-session (Escape / overlay click): hides the dialog without recording an
  // answer, so it re-shows next launch. Component state, not the store — a dismissal is exactly
  // the thing that must NOT persist.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const project = projects.find((p) => p.id === activeProjectId)
  const cap = project ? pendingCapabilityNotice(project) : null
  if (!project || !cap || dismissed.has(`${project.id}:${cap}`)) return null
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
      // "Keep it on" is the grant, so it carries the danger styling; and NO button takes focus
      // (autoFocusButtons={false}) — this dialog appears under the user's hands, and a native
      // Enter/Space on an autofocused button would be an answer they never aimed here.
      danger
      enterConfirms={false}
      autoFocusButtons={false}
      onConfirm={() => recordProjectCapabilityAck(project.id, cap, 'kept')}
      onCancel={() => {
        // The explicit decline: records 'declined' AND sheds the stranger's grant from the file
        // on the next save. The recorded 'declined' is what keeps a re-arriving `true` refused
        // and re-noticed instead of silently granted (C1).
        setProjectCapability(project.id, cap, false)
      }}
      onDismiss={() => {
        // NOT an answer: no ack, no field change — the capability stays refused (no 'kept') and
        // the notice returns next launch.
        setDismissed((s) => new Set(s).add(`${project.id}:${cap}`))
      }}
    />
  )
}
