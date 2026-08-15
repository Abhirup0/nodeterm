import { describe, it, expect } from 'vitest'
import type { Project } from '../shared/types'
import {
  needsCapabilityNotice,
  projectCapabilityGranted,
  recordCapabilityAck
} from './project-capability-consent'
import * as shared from '../shared/project-capability-consent'
import { projectToFile, type IndexEntryV3 } from './workspace-files'

const baseProject: Project = {
  id: 'p1',
  name: 'p',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: []
}

describe('needsCapabilityNotice', () => {
  const cap = 'agentBrowserControl' as const
  it('off in the file ⇒ never a notice', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: false, acknowledged: false })).toBe(false)
  })
  it('on in the file and never acknowledged ON THIS MACHINE ⇒ notice', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, acknowledged: false })).toBe(true)
  })
  it('on and acknowledged ⇒ silent forever after', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, acknowledged: true })).toBe(false)
  })
})

describe('projectCapabilityGranted — a pending notice is a refusal, not a grant', () => {
  const cap = 'agentBrowserControl' as const
  it('a switch that is on but unanswered grants nothing', () => {
    // This is what the ledger (browser PR 4) and messagingEnabled (messaging PR 6) consult: the
    // window between a hostile clone's `agentBrowserControl: true` arriving and the user answering
    // the notice must be a refusal. Deleting the `acknowledged` condition makes this red.
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, acknowledged: false })).toBe(false)
  })
  it('off in the file grants nothing, acknowledged or not', () => {
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: false, acknowledged: true })).toBe(false)
  })
  it('on and acknowledged is the one granting combination', () => {
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, acknowledged: true })).toBe(true)
  })
})

describe('the acknowledgment is MACHINE-LOCAL', () => {
  it('recordCapabilityAck writes to the index entry, never to the project file', () => {
    const e = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl')
    expect(e.capabilityAck).toEqual({ agentBrowserControl: true })
    // The shared file must not learn about it: projectToFile writes only the capability FIELDS.
    expect(Object.keys(projectToFile({ ...baseProject, agentBrowserControl: true }, 1, 't', 'l')))
      .not.toContain('capabilityAck')
  })

  it('does not mutate its input and keeps earlier acks', () => {
    const before: IndexEntryV3 = {
      id: 'p1',
      name: 'p',
      color: '#fff',
      capabilityAck: { agentBrowserControl: true }
    }
    const after = recordCapabilityAck(before, 'agentBrowserControl')
    expect(after).not.toBe(before)
    expect(before.capabilityAck).toEqual({ agentBrowserControl: true })
    expect(after.capabilityAck).toEqual({ agentBrowserControl: true })
  })

  it('a SECOND WORKTREE of the same repo notifies again', () => {
    // node ids and project.json re-materialise in a second folder (git worktree add / checkout /
    // reset --hard), and workspace-files.ts is explicit that the index entry id is the only
    // authority for project identity. A second folder is a second entry, hence a second notice —
    // which is correct: it is a different working copy the user has not vetted.
    const a = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl')
    const b = { id: 'p2', name: 'p', color: '#fff' } // same repo, second worktree, fresh entry
    expect(
      needsCapabilityNotice({
        capability: 'agentBrowserControl',
        enabledInFile: true,
        acknowledged: !!a.capabilityAck?.agentBrowserControl
      })
    ).toBe(false)
    expect(
      needsCapabilityNotice({
        capability: 'agentBrowserControl',
        enabledInFile: true,
        acknowledged: !!(b as IndexEntryV3).capabilityAck?.agentBrowserControl
      })
    ).toBe(true)
  })
})

describe('one decider, two consumers', () => {
  it('core re-exports the SAME functions the renderer imports from @shared — no drift possible', () => {
    // Same rule as isSafeNodeId: the renderer may not import src/core, so the implementation lives
    // in @shared/project-capability-consent and this core path re-exports it for main/core callers
    // (agent-messaging PR 6 Task 6.2 must not reimplement either function).
    expect(needsCapabilityNotice).toBe(shared.needsCapabilityNotice)
    expect(recordCapabilityAck).toBe(shared.recordCapabilityAck)
    expect(projectCapabilityGranted).toBe(shared.projectCapabilityGranted)
  })
})
