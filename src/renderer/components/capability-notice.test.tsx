// @vitest-environment jsdom
//
// THE one thing standing between a hostile project.json and a grant (PR 3 Task 3.4): a cloned repo
// can arrive with `agentBrowserControl: true` already in its git-shared file. The notice must
//  - appear on the project whose switch is on and whose machine-local entry holds no ack,
//  - name the project and what the switch permits (the capability's own copy, not a paraphrase),
//  - be CLICK-ONLY (it was raised by a file, not by the user — confirm-key.ts's enterConfirms rule),
//  - record the answer machine-locally (Project.capabilityAck → IndexEntryV3.capabilityAck; the
//    shared file's bytes are pinned unchanged by workspace-files.test.ts "the ack is machine-local"
//    and project-capability-consent.test.ts — the renderer cannot import src/core to re-assert it),
//  - never grant while unanswered: projectCapabilityGranted is false until the click.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '@shared/types'
import { PROJECT_CAPABILITY_COPY, projectCapabilityEnabled } from '@shared/project-capabilities'
import { projectCapabilityGranted } from '@shared/project-capability-consent'
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

/** The grantedness the ledger/messaging wiring would compute from the live store, per call. */
function grantedNow(): boolean {
  const p = useProjects.getState().getProject('p1')
  return projectCapabilityGranted({
    capability: cap,
    enabledInFile: projectCapabilityEnabled(p, cap),
    acknowledged: p?.capabilityAck?.[cap] === true
  })
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
  it('renders for an on-in-file, never-acknowledged project, naming the project and the grant', () => {
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

  it('does not grant while unanswered — the switch alone is not consent', () => {
    mount()
    expect(grantedNow()).toBe(false)
  })

  it('"Keep it on": records the machine-local ack, leaves the shared field untouched, then grants', () => {
    mount()
    act(() => button('Keep it on').click())
    const p = useProjects.getState().getProject('p1')!
    expect(p.capabilityAck).toEqual({ [cap]: true })
    expect(p[cap]).toBe(true) // the git-shared half did not change — no bytes moved in the file
    expect(grantedNow()).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('"Turn it off": clears the field, records the answer, and still grants nothing', () => {
    mount()
    act(() => button('Turn it off').click())
    const p = useProjects.getState().getProject('p1')!
    expect(p[cap]).toBeUndefined()
    expect(p.capabilityAck).toEqual({ [cap]: true })
    expect(grantedNow()).toBe(false)
    expect(dialog()).toBeNull()
  })

  it('a second open does not re-notify — the ack is once per project ever', () => {
    mount()
    act(() => button('Keep it on').click())
    unmount()
    mount()
    expect(dialog()).toBeNull()
  })

  it('never appears for a switch the user set personally — the setter is its own acknowledgment', () => {
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    useProjects.getState().setProjectCapability('p1', cap, true)
    mount()
    expect(dialog()).toBeNull()
    expect(grantedNow()).toBe(true)
  })

  it('stays silent when the switch is off', () => {
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    mount()
    expect(dialog()).toBeNull()
  })
})
