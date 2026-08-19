// @vitest-environment jsdom
//
// Settings → Project → Terminal: the theme row is a SELECT over the ids this build ships, not a
// free-text box — and the two copy corrections that ride with it.
//
// A typed theme id was unverifiable: the merge (`mergeProjectVisuals`) ignores an id it does not
// know, so a typo left the terminal on the global theme with nothing on screen saying why. The
// Select removes the failure mode; what it must NOT do is erase a value it does not recognise —
// a teammate's newer theme, or one since removed, is a real value in a real document.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProjectSettingsDoc, ResolvedProjectSettings } from '@shared/project-settings'
import { TERMINAL_THEMES } from '@renderer/terminal/themes'
import { ProjectFamilyEditors } from './ProjectSettingsFamilies'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let sharedWrites: ProjectSettingsDoc[] = []
let localWrites: (ProjectSettingsDoc | undefined)[] = []

const EMPTY: ResolvedProjectSettings = { setup: {}, worktree: {}, agents: {}, terminal: {} }

function mount(opts: {
  shared?: ProjectSettingsDoc
  local?: ProjectSettingsDoc
  resolved?: ResolvedProjectSettings
}): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <ProjectFamilyEditors
        projectId="p1"
        snapshot={{
          shared: opts.shared
            ? { version: 1, rev: 1, savedAt: '2026-08-19T00:00:00.000Z', ...opts.shared }
            : null,
          local: opts.local
        }}
        resolved={opts.resolved ?? EMPTY}
        conflict={false}
        sharedEditable
        canRun
        saveShared={async (doc) => {
          sharedWrites.push(doc)
          return true
        }}
        saveLocal={async (update) => {
          localWrites.push(update(opts.local))
          return true
        }}
        reload={() => {}}
      />
    )
  )
}

/** The two theme controls: the shared row's select, then its "this machine" twin. */
function themeSelects(): HTMLSelectElement[] {
  return [
    host.querySelector('#project-terminal-theme-p1') as HTMLSelectElement,
    host.querySelector('#project-terminal-theme-local-p1') as HTMLSelectElement
  ]
}

const optionValues = (sel: HTMLSelectElement): string[] => [...sel.options].map((o) => o.value)

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {}
  sharedWrites = []
  localWrites = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Terminal family — the theme Select', () => {
  it('offers inherit plus every theme this build ships, on both rows', () => {
    mount({})
    const selects = themeSelects()
    expect(selects[0]).toBeTruthy()
    expect(selects[1]).toBeTruthy()
    for (const sel of selects) {
      // The REAL id list, read from the same module the renderer resolves against — a hand-written
      // copy here would let the two drift silently.
      expect(optionValues(sel)).toEqual(['', ...TERMINAL_THEMES.map((t) => t.id)])
      expect(sel.options[0].textContent).toMatch(/inherit/i)
      // Not a placeholder list: the ids are the ones the terminal actually resolves.
      expect(optionValues(sel)).toContain('nodeterm-dark')
      expect(optionValues(sel)).toContain('catppuccin-mocha')
    }
    expect(selects[0].value).toBe('') // unset reads as inherit, not as a theme
  })

  it('shows the stored id on the row that stores it', () => {
    mount({ shared: { terminal: { theme: 'dracula' } }, local: { terminal: { theme: 'nord' } } })
    const [shared, local] = themeSelects()
    expect(shared.value).toBe('dracula')
    expect(local.value).toBe('nord')
  })

  it('keeps an id this build does not know readable instead of showing it as inherit', () => {
    mount({ shared: { terminal: { theme: 'from-a-newer-version' } } })
    const [shared, local] = themeSelects()
    expect(shared.value).toBe('from-a-newer-version')
    expect([...shared.options].at(-1)?.textContent).toContain('from-a-newer-version')
    // Only where the value actually is — the local row sets nothing and stays on inherit.
    expect(local.value).toBe('')
    expect(optionValues(local)).not.toContain('from-a-newer-version')
  })

  it('writes the picked id, and clears the field when inherit is picked', () => {
    mount({ shared: { terminal: { theme: 'dracula' } } })
    const [shared] = themeSelects()
    act(() => {
      shared.value = 'nord'
      shared.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(sharedWrites).toEqual([{ terminal: { theme: 'nord' } }])
    act(() => {
      shared.value = ''
      shared.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(sharedWrites[1]).toEqual({ terminal: { theme: undefined } })
  })

  it('writes a local pick to the local overlay, leaving the shared document alone', () => {
    mount({ shared: { terminal: { theme: 'dracula' } } })
    const [, local] = themeSelects()
    act(() => {
      local.value = 'tokyo-night'
      local.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(localWrites).toEqual([{ terminal: { theme: 'tokyo-night' } }])
    expect(sharedWrites).toEqual([])
  })

  it('names the local row distinctly from its shared twin, for a screen reader', () => {
    mount({})
    const [shared, local] = themeSelects()
    expect(shared.getAttribute('aria-label')).toBeNull() // named by its own <label>
    expect(local.getAttribute('aria-label')).toBe('Theme (this machine)')
  })
})

describe('Setup family copy — what the rows actually promise', () => {
  it('names every trigger the setup script runs on, not just creation', () => {
    mount({})
    const text = host.textContent ?? ''
    expect(text).toContain('created, adopted, or re-bound to a group')
  })

  // The switch never held a terminal back: the node opens either way. What waits is its QUEUED
  // LAUNCH COMMAND (`launchesToFire`'s setup gate).
  it('describes waitForSetup as holding the queued command, not the terminal', () => {
    mount({})
    const text = host.textContent ?? ''
    expect(text).toContain('Hold queued launch commands until the setup script finishes')
    expect(text).toContain('only their queued command waits')
    expect(text).not.toContain('before opening a terminal')
  })
})
