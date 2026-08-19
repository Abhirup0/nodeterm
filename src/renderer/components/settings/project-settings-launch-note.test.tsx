// @vitest-environment jsdom
//
// Settings → Project → Agents: the "this launch command does nothing" caveat.
//
// The launch layer (`workspace.ts agentLaunchOverride`) consumes a project's `launchCmd` ONLY for
// the agent that same project names in `defaultAgentId`, and deliberately never falls back to this
// machine's global default agent. That makes a launchCmd typed without a default agent id INERT —
// and an inert setting that looks saved is a lie the panel has to correct on the row itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ResolvedProjectSettings } from '@shared/project-settings'
import { LAUNCH_CMD_UNPAIRED_NOTE, ProjectFamilyEditors } from './ProjectSettingsFamilies'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const resolved = (agents: ResolvedProjectSettings['agents']): ResolvedProjectSettings => ({
  setup: {},
  worktree: {},
  agents,
  terminal: {}
})

function mount(agents: ResolvedProjectSettings['agents']): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <ProjectFamilyEditors
        projectId="p1"
        snapshot={{ shared: null, local: undefined }}
        resolved={resolved(agents)}
        conflict={false}
        sharedEditable
        canRun
        saveShared={async () => true}
        saveLocal={async () => true}
        reload={() => {}}
      />
    )
  )
}

/** Every field row whose visible label is `label` (the shared row and its "this machine" twin). */
function rows(label: string): HTMLElement[] {
  return [...host.querySelectorAll('label')]
    .filter((el) => el.textContent === label)
    .map((el) => el.parentElement as HTMLElement)
}

const noteCount = (): number => (host.textContent ?? '').split(LAUNCH_CMD_UNPAIRED_NOTE).length - 1

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {}
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Agents family — the unpaired launch command note', () => {
  it('warns on BOTH launch-command rows when a launchCmd is set with no default agent id', () => {
    mount({ launchCmd: { value: 'nix develop -c claude', source: 'shared' } })
    const launchRows = rows('Launch command')
    expect(launchRows).toHaveLength(2) // shared + "this machine"
    for (const row of launchRows) expect(row.textContent).toContain(LAUNCH_CMD_UNPAIRED_NOTE)
    // On the launchCmd rows and nowhere else — the caveat is about that field.
    expect(noteCount()).toBe(2)
    for (const row of rows('Default agent')) {
      expect(row.textContent).not.toContain(LAUNCH_CMD_UNPAIRED_NOTE)
    }
  })

  it('warns for a launchCmd this machine set locally too — pairing, not provenance', () => {
    mount({ launchCmd: { value: 'nix develop -c claude', source: 'local' } })
    expect(noteCount()).toBe(2)
  })

  it('says nothing once the project also names its default agent', () => {
    mount({
      defaultAgentId: { value: 'claude', source: 'shared' },
      launchCmd: { value: 'nix develop -c claude', source: 'shared' }
    })
    expect(noteCount()).toBe(0)
    // The provenance note the caveat displaces is back where it belongs.
    expect(rows('Launch command')[0].textContent).not.toContain(LAUNCH_CMD_UNPAIRED_NOTE)
  })

  it('says nothing when the project sets no launch command at all', () => {
    mount({ defaultAgentId: { value: 'claude', source: 'shared' } })
    expect(noteCount()).toBe(0)
    act(() => root.unmount())
    host.remove()
    mount({})
    expect(noteCount()).toBe(0)
  })
})
