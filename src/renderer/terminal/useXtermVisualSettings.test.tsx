// @vitest-environment jsdom
//
// Project-scoped terminal appearance, end to end through the hook: a project's `terminal.theme` /
// `terminal.fontFamily` reaching the terminals of THAT project (and no other), live.
//
// The pure merge is covered in terminal-config.test.ts. What is proved here is the seam the merge
// hangs off — the reactive mirror of the launch-info cache (`useProjectVisuals`) — and the two
// properties that make it safe to put in front of a canvas full of live terminals:
//  - a project's terminals re-render when ITS values change, and other projects' do not,
//  - nothing re-renders when an UNRELATED part of the launch-info answer moves (a launch command, a
//    trust verdict), which is why the mirror carries the appearance slice alone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProjectLaunchInfo, ResolvedProjectSettings } from '@shared/project-settings'
import {
  ensureProjectLaunchInfo,
  invalidateProjectLaunchInfo,
  resetProjectLaunchInfoForTests
} from '../state/projectLaunchInfo'
import { useSettings } from '../state/settings'
import { useXtermVisualSettings } from './useXtermVisualSettings'
import { xtermOptionsFromSettings } from './terminal-config'
import { resolveTerminalTheme } from './themes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const info = (
  terminal: ResolvedProjectSettings['terminal'],
  agents: ResolvedProjectSettings['agents'] = {}
): ProjectLaunchInfo => ({
  resolved: { setup: {}, worktree: {}, agents, terminal },
  trusted: { agents: true, shell: true }
})

/** Stand in for the preload/bridge `projectSettings.launchInfo()` call — answers per project id. */
function mockLaunchInfo(byProject: Record<string, ProjectLaunchInfo | null>): void {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    projectSettings: {
      launchInfo: vi.fn((projectId: string) => Promise.resolve(byProject[projectId] ?? null))
    }
  }
}

interface Probe {
  /** What the hook last answered. */
  theme: () => string
  font: () => string
  /** How many times the component rendered — the re-render assertions live on this. */
  renders: () => number
  unmount: () => void
}

/** Mount one component that consumes the hook for `projectId`, recording every render. */
function probe(projectId?: string): Probe {
  let renders = 0
  let last = { terminalTheme: '', fontFamily: '' }
  function Probed(): null {
    renders += 1
    const v = useXtermVisualSettings(projectId)
    last = { terminalTheme: v.terminalTheme, fontFamily: v.fontFamily }
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => root.render(<Probed />))
  return {
    theme: () => last.terminalTheme,
    font: () => last.fontFamily,
    renders: () => renders,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

const GLOBAL = { terminalTheme: 'nord', fontFamily: 'Menlo' }
let mounted: Probe[] = []

beforeEach(() => {
  resetProjectLaunchInfoForTests()
  useSettings.setState((s) => ({ settings: { ...s.settings, ...GLOBAL } }))
})

afterEach(() => {
  for (const p of mounted) p.unmount()
  mounted = []
})

const mount = (projectId?: string): Probe => {
  const p = probe(projectId)
  mounted.push(p)
  return p
}

describe('useXtermVisualSettings — project-scoped appearance', () => {
  it('starts on the global settings and picks the project up when its info lands', async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'dracula', source: 'shared' } }) })
    const p = mount('p1')
    expect(p.theme()).toBe('nord') // nothing fetched yet — the global setting, not a blank
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    // The whole point of doing this live: the terminal that is ALREADY on screen repaints — the
    // hook re-rendered its consumer with the project's theme, which is what feeds applyLiveOptions.
    expect(p.theme()).toBe('dracula')
    expect(xtermOptionsFromSettings({ ...useSettings.getState().settings, terminalTheme: p.theme() })
      .theme).toBe(resolveTerminalTheme('dracula').theme)
  })

  it("leaves another project's terminals on the global theme", async () => {
    mockLaunchInfo({
      p1: info({ theme: { value: 'dracula', source: 'shared' } }),
      p2: info({})
    })
    const one = mount('p1')
    const two = mount('p2')
    await act(async () => {
      await Promise.all([ensureProjectLaunchInfo('p1'), ensureProjectLaunchInfo('p2')])
    })
    expect(one.theme()).toBe('dracula')
    expect(two.theme()).toBe('nord')
  })

  it('takes a LOCAL override the same as a shared one — appearance is not gated', async () => {
    mockLaunchInfo({
      p1: {
        ...info({ theme: { value: 'tokyo-night', source: 'local' } }),
        // Untrusted shared content: irrelevant here. `shell` is the gated field in this family;
        // a colour cannot execute anything.
        trusted: { agents: false, shell: false }
      }
    })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('tokyo-night')
  })

  it('falls back to the GLOBAL theme for an id this build does not know', async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'from-a-newer-version', source: 'shared' } }) })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('nord')
    expect(resolveTerminalTheme(p.theme()).id).toBe('nord')
  })

  it('overrides the font family, and only for that project', async () => {
    mockLaunchInfo({
      p1: info({ fontFamily: { value: 'Iosevka', source: 'shared' } }),
      p2: info({})
    })
    const one = mount('p1')
    const two = mount('p2')
    await act(async () => {
      await Promise.all([ensureProjectLaunchInfo('p1'), ensureProjectLaunchInfo('p2')])
    })
    expect(one.font()).toBe('Iosevka')
    expect(one.theme()).toBe('nord') // untouched by a font-only override
    expect(two.font()).toBe('Menlo')
  })

  it('gives a project-less terminal (the settings preview) the global settings', async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'dracula', source: 'shared' } }) })
    const p = mount(undefined)
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('nord')
    expect(p.font()).toBe('Menlo')
  })

  it('re-renders on nothing but the appearance slice of a launch-info answer', async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'dracula', source: 'shared' } }) })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    const afterTheme = p.renders()
    // A second answer that changes only the launch command and the trust verdict — a terminal has
    // no business repainting for either.
    mockLaunchInfo({
      p1: {
        ...info(
          { theme: { value: 'dracula', source: 'shared' } },
          { launchCmd: { value: 'nix develop -c claude', source: 'shared' } }
        ),
        trusted: { agents: false, shell: false }
      }
    })
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('dracula')
    // NOT ONE extra render: the mirror mirrors the appearance slice alone, and re-answering the
    // same two values must not touch the entry a canvas full of terminals is subscribed to.
    expect(p.renders()).toBe(afterTheme)
  })

  // `invalidate` runs after EVERY project-settings commit, of every family — a setup-script edit
  // invalidates too. Dropping the mirrored appearance there would repaint the project's terminals
  // to the global theme (and, with a project font, re-fit their grids into a possibly co-attached
  // pty) on the way to re-reading the very document that hands the same value straight back — a
  // flash on every committed field, seconds wide on an SSH project.
  it('holds the project theme across an invalidate, so an unrelated save does not flash', async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'dracula', source: 'shared' } }) })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    const settled = p.renders()
    // What a setup-script save does: invalidate, then re-warm.
    act(() => invalidateProjectLaunchInfo('p1'))
    expect(p.theme()).toBe('dracula')
    expect(p.renders()).toBe(settled) // not even a re-render, let alone a repaint
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('dracula')
    expect(p.renders()).toBe(settled)
  })

  // Holding needs no expiry because the fresh read OVERWRITES unconditionally: this is the case
  // that would otherwise strand a stale theme on screen — the override itself being deleted.
  it('clears a held theme when the answer after an invalidate no longer sets one', async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'dracula', source: 'shared' } }) })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('dracula')
    mockLaunchInfo({ p1: info({}) }) // the user removed the project's theme
    act(() => invalidateProjectLaunchInfo('p1'))
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    expect(p.theme()).toBe('nord') // back to this machine's global setting, once and only once
  })

  it('keeps following the global setting for a project that overrides nothing', async () => {
    mockLaunchInfo({ p1: info({}) })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    act(() => {
      // `setState`, not `update()`: the store's real setter also schedules a disk save through a
      // preload this test does not stand up. What is under test is the SUBSCRIPTION.
      useSettings.setState((s) => ({ settings: { ...s.settings, terminalTheme: 'gruvbox-dark' } }))
    })
    expect(p.theme()).toBe('gruvbox-dark')
  })

  it("lets the project's theme survive an unrelated global appearance edit", async () => {
    mockLaunchInfo({ p1: info({ theme: { value: 'dracula', source: 'shared' } }) })
    const p = mount('p1')
    await act(async () => {
      await ensureProjectLaunchInfo('p1')
    })
    act(() => {
      useSettings.setState((s) => ({
        settings: { ...s.settings, terminalTheme: 'one-dark', fontFamily: 'Fira Code' }
      }))
    })
    expect(p.theme()).toBe('dracula') // the project still wins
    expect(p.font()).toBe('Fira Code') // …and the un-overridden half follows the global edit
  })
})
