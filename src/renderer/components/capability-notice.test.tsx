// @vitest-environment jsdom
//
// THE one thing standing between a hostile project.json and a grant (PR 3 Task 3.4 + PR #213
// review fixes C1/I1): a cloned repo can arrive with `agentBrowserControl: true` already in its
// git-shared file. The notice must
//  - appear on the project whose switch is on and whose machine-local entry holds no KEPT answer,
//  - name the project and what the switch permits (the capability's own copy, not a paraphrase),
//  - accept ONLY the two buttons as answers: Enter never confirms, Escape/overlay dismissal
//    records NOTHING and re-shows next launch, and no button holds focus for a native Enter/Space
//    to activate (I1),
//  - record WHICH answer was given ('kept'/'declined') machine-locally (Project.capabilityAck →
//    IndexEntryV3.capabilityAck; the shared file's bytes are pinned unchanged by
//    workspace-files.test.ts "the ack is machine-local" — the renderer cannot import src/core to
//    re-assert it),
//  - never grant while unanswered or declined: a declined switch whose hostile `true` re-arrives
//    via git is refused AND re-noticed, never silently granted (C1).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '@shared/types'
import { PROJECT_CAPABILITY_COPY } from '@shared/project-capabilities'
import { projectCapabilityGrantedFor } from '@shared/project-capability-consent'
import { useProjects } from '../state/projects'
import { CONFIRM_ARM_MS } from './confirm-key'
import { CapabilityNotice } from './CapabilityNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cap = 'agentBrowserControl' as const

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'cloned-repo',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

let root: Root
let host: HTMLElement

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<CapabilityNotice />))
}

function unmount(): void {
  act(() => root.unmount())
  host.remove()
}

function dialog(): HTMLElement | null {
  return document.querySelector('.confirm')
}

function button(label: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find(
    (b) => b.textContent === label
  )
  expect(el, `button "${label}"`).toBeTruthy()
  return el!
}

/** The grantedness the ledger/messaging wiring computes from the live store, per call. */
function grantedNow(): boolean {
  return projectCapabilityGrantedFor(useProjects.getState().getProject('p1'), cap)
}

beforeEach(() => {
  useProjects.setState({
    projects: [project({ [cap]: true })],
    activeProjectId: 'p1',
    reloadNonce: 0
  })
})

afterEach(() => {
  unmount()
  useProjects.setState({ projects: [], activeProjectId: '' })
})

describe('the one-time clone notice', () => {
  it('renders for an on-in-file, never-answered project, naming the project and the grant', () => {
    mount()
    expect(dialog()).toBeTruthy()
    const text = dialog()!.textContent ?? ''
    expect(text).toContain('cloned-repo')
    expect(text).toContain(PROJECT_CAPABILITY_COPY[cap].description)
    expect(text).toContain(PROJECT_CAPABILITY_COPY[cap].cloneWarning)
  })

  it('is CLICK-ONLY: Enter aimed into the dialog confirms nothing', async () => {
    mount()
    // Outwait CONFIRM_ARM_MS first: a fresh dialog ignores Enter for 500ms REGARDLESS of
    // enterConfirms, so dispatching immediately would pass even if the click-only prop were
    // dropped. Past the arm window, only `enterConfirms={false}` stands between this Enter and a
    // confirmation — which is exactly the mutation this test exists to catch.
    await new Promise((r) => setTimeout(r, CONFIRM_ARM_MS + 150))
    const box = dialog()!
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(dialog()).toBeTruthy()
    expect(useProjects.getState().getProject('p1')?.capabilityAck).toBeUndefined()
  })

  it('holds focus on NO button, so a native Enter/Space mid-typing cannot answer it (I1)', () => {
    // The real-browser hole: autoFocus would steal focus from whatever the user was typing in,
    // and their next Enter/Space would NATIVELY activate the focused button — a path the window
    // keydown listener (and enterConfirms) never sees. With autoFocusButtons={false} nothing in
    // the dialog takes focus, so there is no button for that keystroke to land on.
    const typing = document.createElement('input')
    document.body.appendChild(typing)
    typing.focus()
    mount()
    expect(dialog()).toBeTruthy()
    expect(document.activeElement).toBe(typing)
    for (const b of document.querySelectorAll('.confirm button')) {
      expect(document.activeElement).not.toBe(b)
    }
    typing.remove()
  })

  it('does not grant while unanswered — the switch alone is not consent', () => {
    mount()
    expect(grantedNow()).toBe(false)
  })

  it('"Keep it on": records the machine-local KEPT, leaves the shared field untouched, then grants', () => {
    mount()
    act(() => button('Keep it on').click())
    const p = useProjects.getState().getProject('p1')!
    expect(p.capabilityAck).toEqual({ [cap]: 'kept' })
    expect(p[cap]).toBe(true) // the git-shared half did not change — no bytes moved in the file
    expect(grantedNow()).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('"Turn it off": clears the field, records DECLINED, and still grants nothing', () => {
    mount()
    act(() => button('Turn it off').click())
    const p = useProjects.getState().getProject('p1')!
    expect(p[cap]).toBeUndefined()
    expect(p.capabilityAck).toEqual({ [cap]: 'declined' })
    expect(grantedNow()).toBe(false)
    expect(dialog()).toBeNull()
  })

  it('C1: a declined switch whose hostile true RE-ARRIVES is refused AND re-noticed — never a silent grant', () => {
    mount()
    act(() => button('Turn it off').click())
    unmount()
    // The user's field-deletion was only an uncommitted diff. A `git checkout`/pull restores the
    // hostile `true`; the watcher's re-read rebuilds the project from the file with the
    // machine-local ack threaded back in from the index entry — exactly this shape:
    act(() => {
      useProjects
        .getState()
        .replaceProject(project({ [cap]: true, capabilityAck: { [cap]: 'declined' } }))
    })
    expect(grantedNow()).toBe(false) // the standing "no" refuses; the bare-bit ack would grant here
    mount()
    expect(dialog()).toBeTruthy() // and the user is told AGAIN — a new notice, not silence
  })

  it('Escape is a NON-answer: nothing recorded, nothing granted, and the notice returns next launch (I1)', () => {
    mount()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(dialog()).toBeNull() // closed for this session…
    const p = useProjects.getState().getProject('p1')!
    expect(p.capabilityAck).toBeUndefined() // …but no answer was recorded
    expect(p[cap]).toBe(true) // and the user's working copy was not silently edited
    expect(grantedNow()).toBe(false)
    unmount()
    mount() // next launch
    expect(dialog()).toBeTruthy()
  })

  it('an overlay misclick is a NON-answer too (I1)', () => {
    mount()
    act(() => {
      document.querySelector<HTMLElement>('.confirm-overlay')!.click()
    })
    expect(dialog()).toBeNull()
    expect(useProjects.getState().getProject('p1')?.capabilityAck).toBeUndefined()
    expect(grantedNow()).toBe(false)
    unmount()
    mount()
    expect(dialog()).toBeTruthy()
  })

  it('a second open does not re-notify after an explicit KEEP — answered is answered', () => {
    mount()
    act(() => button('Keep it on').click())
    unmount()
    mount()
    expect(dialog()).toBeNull()
  })

  it('never appears for a switch the user set personally — the setter records its own KEPT', () => {
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    useProjects.getState().setProjectCapability('p1', cap, true)
    mount()
    expect(dialog()).toBeNull()
    expect(grantedNow()).toBe(true)
  })

  it('fires for agentMessaging too — the machinery is per-capability, nothing above is browser-specific', () => {
    // Messaging PR 6 adds only the registry entry; a cloned repo arriving with
    // `agentMessaging: true` must get exactly this dialog, with messaging's own copy.
    useProjects.setState({ projects: [project({ agentMessaging: true })], activeProjectId: 'p1' })
    mount()
    expect(dialog()).toBeTruthy()
    const text = dialog()!.textContent ?? ''
    expect(text).toContain(PROJECT_CAPABILITY_COPY.agentMessaging.label)
    expect(text).toContain(PROJECT_CAPABILITY_COPY.agentMessaging.description)
    // Unanswered = refused: the exact predicate messagingEnabled consults.
    expect(
      projectCapabilityGrantedFor(useProjects.getState().getProject('p1'), 'agentMessaging')
    ).toBe(false)
    act(() => button('Turn it off').click())
    const p = useProjects.getState().getProject('p1')!
    expect(p.agentMessaging).toBeUndefined()
    expect(p.capabilityAck).toEqual({ agentMessaging: 'declined' })
  })

  it('stays silent when the switch is off', () => {
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    mount()
    expect(dialog()).toBeNull()
  })
})
