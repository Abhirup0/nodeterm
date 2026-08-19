// @vitest-environment jsdom
//
// Settings → Project → Worktree: honest field copy + the "inert on SSH" caveat.
//
// Worktrees are LOCAL-only (`git worktree` runs against the project's own filesystem), so on an SSH
// project none of these settings can take effect. An inert setting that looks editable is a lie the
// panel has to correct on the row itself — same mechanism as the Agents family's unpaired launchCmd
// note. The base-path / shared-paths descriptions are also asserted here: they must describe what
// the code actually does, and must avoid the literal substring "project" (the searchable copy would
// otherwise make the non-discriminating query "project" match the whole pane).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ResolvedProjectSettings } from '@shared/project-settings'
import { WORKTREE_SSH_INERT_NOTE, ProjectFamilyEditors } from './ProjectSettingsFamilies'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const EMPTY_RESOLVED: ResolvedProjectSettings = { setup: {}, worktree: {}, agents: {}, terminal: {} }

function mount({ ssh = false }: { ssh?: boolean } = {}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <ProjectFamilyEditors
        projectId="p1"
        snapshot={{ shared: null, local: undefined }}
        resolved={EMPTY_RESOLVED}
        conflict={false}
        sharedEditable
        canRun
        ssh={ssh}
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

const noteCount = (): number => (host.textContent ?? '').split(WORKTREE_SSH_INERT_NOTE).length - 1

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {}
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Worktree family — honest field copy', () => {
  it('describes shared paths by what the linker actually does', () => {
    mount()
    const sharedPaths = rows('Shared paths')[0]
    expect(sharedPaths.textContent).toContain('symlinked into each new worktree')
    // The honest caveats: missing source / pre-existing target are SKIPPED, not errors.
    expect(sharedPaths.textContent).toContain('Skipped when the source is missing')
    expect(sharedPaths.textContent).toContain('the target already exists')
  })

  it('gives the base path a description saying it overrides the global template', () => {
    mount()
    const basePath = rows('Base path')[0]
    expect(basePath.textContent).toContain('new worktrees are created under')
    expect(basePath.textContent).toContain('overrides the global template')
  })

  it('keeps its searchable copy free of the literal "project" substring', () => {
    // The non-discriminating query "project" must not match every worktree field (it would mount
    // every open project's pane). Descriptions are searchable, so they carry no "project".
    mount()
    for (const label of ['Base path', 'Base ref', 'Shared paths']) {
      const desc = rows(label)[0].querySelector('p')?.textContent ?? ''
      expect(desc.toLowerCase()).not.toContain('project')
    }
  })
})

describe('Worktree family — the SSH-inert caveat', () => {
  it('warns on EVERY worktree row (shared + this machine) for an SSH project', () => {
    mount({ ssh: true })
    for (const label of ['Base path', 'Base ref', 'Shared paths']) {
      const labelRows = rows(label)
      expect(labelRows).toHaveLength(2) // shared + "this machine"
      for (const row of labelRows) expect(row.textContent).toContain(WORKTREE_SSH_INERT_NOTE)
    }
    // Six worktree rows, and only those.
    expect(noteCount()).toBe(6)
  })

  it('says nothing for a local project', () => {
    mount({ ssh: false })
    expect(noteCount()).toBe(0)
  })

  it('does not leak the worktree caveat onto other families', () => {
    mount({ ssh: true })
    for (const row of rows('Shell')) {
      expect(row.textContent).not.toContain(WORKTREE_SSH_INERT_NOTE)
    }
  })
})
