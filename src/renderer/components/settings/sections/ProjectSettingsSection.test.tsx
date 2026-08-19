// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import type { ProjectSettingsSnapshot } from '@shared/project-settings'
import { useProjects } from '../../../state/projects'
import { SettingsSearchContext } from '../context'
import { ProjectSettingsSection } from './ProjectSettingsSection'
import { useProjectSettings, type ProjectSettingsHook } from '../useProjectSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    color: '#0a84ff',
    cwd: '/repo/alpha',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    ...over
  }
}

const EMPTY_SNAPSHOT: ProjectSettingsSnapshot = { shared: null, local: undefined }

describe('ProjectSettingsSection', () => {
  let root: Root
  let host: HTMLElement
  let read: ReturnType<typeof vi.fn>
  let writeShared: ReturnType<typeof vi.fn>
  let updateLocal: ReturnType<typeof vi.fn>
  let save: ReturnType<typeof vi.fn>

  const mount = async (node: React.JSX.Element, query = ''): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(<SettingsSearchContext.Provider value={query}>{node}</SettingsSearchContext.Provider>)
    })
  }

  const mountSection = async (
    p: Project = project(),
    { isActive = true, query = '' }: { isActive?: boolean; query?: string } = {}
  ): Promise<void> => {
    useProjects.setState({ projects: [p], activeProjectId: p.id })
    await mount(<ProjectSettingsSection projectId={p.id} isActive={isActive} />, query)
  }

  const typeInto = async (el: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const nameInput = (): HTMLInputElement => host.querySelector<HTMLInputElement>('#project-name-p1')!

  /** A real blur fires `focusout`, which is what React's `onBlur` listens for. */
  const blur = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    read = vi.fn(async () => EMPTY_SNAPSHOT)
    writeShared = vi.fn(async () => true)
    updateLocal = vi.fn(async () => true)
    save = vi.fn(async () => undefined)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      projectSettings: { read, writeShared, updateLocal },
      workspace: { save }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useProjects.setState({ projects: [], activeProjectId: '' })
  })

  it('titles the section with the project and shows its folder', async () => {
    await mountSection()
    expect(host.textContent).toContain('Alpha')
    expect(host.textContent).toContain('/repo/alpha')
    expect(nameInput().value).toBe('Alpha')
    expect(read).toHaveBeenCalledWith('p1')
  })

  it('shows an SSH project as user@host:path', async () => {
    await mountSection(
      project({ ssh: { server: { host: 'box', user: 'enes' } as never, remoteCwd: '/srv/app' } })
    )
    expect(host.textContent).toContain('enes@box:/srv/app')
  })

  it('renames the project on BLUR only, then saves the workspace', async () => {
    await mountSection()
    await typeInto(nameInput(), 'Beta')
    // Still un-renamed while typing: each save is a disk write, so the commit waits for blur.
    expect(useProjects.getState().getProject('p1')?.name).toBe('Alpha')
    expect(save).not.toHaveBeenCalled()
    await blur(nameInput())
    expect(useProjects.getState().getProject('p1')?.name).toBe('Beta')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].projects[0].name).toBe('Beta')
  })

  it('ignores a blank rename instead of writing an unnamed project', async () => {
    await mountSection()
    await typeInto(nameInput(), '   ')
    await blur(nameInput())
    expect(useProjects.getState().getProject('p1')?.name).toBe('Alpha')
    expect(save).not.toHaveBeenCalled()
  })

  it('picks a color and persists it', async () => {
    await mountSection()
    const swatch = host.querySelector<HTMLButtonElement>('button[data-project-color="#32d74b"]')!
    await act(async () => {
      swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.color).toBe('#32d74b')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('sets the default permission mode and clears it back to the global default', async () => {
    await mountSection()
    const select = host.querySelector<HTMLSelectElement>('#project-permission-mode-p1')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'plan')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.defaultPermissionMode).toBe('plan')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, '')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.defaultPermissionMode).toBeUndefined()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('shows the conflict banner when the shared file is git-conflicted', async () => {
    read = vi.fn(async () => ({ shared: null, local: undefined, conflict: true }) as ProjectSettingsSnapshot)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    expect(host.textContent).toContain('conflict')
    expect(host.textContent).toContain('.nodeterm/settings.json')
  })

  it('offers no editors at all for a relay (remote) project', async () => {
    await mountSection(project({ remote: true }))
    expect(host.textContent).toContain('Alpha')
    expect(host.querySelectorAll('input, select, textarea, button')).toHaveLength(0)
    // A relay tab's project settings live on the OTHER machine — never read ours for it.
    expect(read).not.toHaveBeenCalled()
  })

  it('offers no editors for an unavailable project', async () => {
    await mountSection(project({ unavailable: true }))
    expect(host.querySelectorAll('input, select, textarea, button')).toHaveLength(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads nothing for a section that is neither active nor matched by the search', async () => {
    await mountSection(project(), { isActive: false })
    expect(host.textContent).toBe('')
    expect(read).not.toHaveBeenCalled()
  })

  it('renders (and reads) when a search query matches the project name', async () => {
    await mountSection(project(), { isActive: false, query: 'alph' })
    expect(host.textContent).toContain('Alpha')
    expect(read).toHaveBeenCalledWith('p1')
  })
})

describe('useProjectSettings', () => {
  let root: Root
  let host: HTMLElement
  let hook: ProjectSettingsHook
  let read: ReturnType<typeof vi.fn>
  let writeShared: ReturnType<typeof vi.fn>
  let updateLocal: ReturnType<typeof vi.fn>

  function Probe({ projectId }: { projectId: string }): React.JSX.Element {
    hook = useProjectSettings(projectId)
    return <div>{hook.snapshot === 'loading' ? 'loading' : JSON.stringify(hook.resolved)}</div>
  }

  const mount = async (): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(<Probe projectId="p1" />)
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    read = vi.fn(async () => ({
      shared: { version: 1, rev: 3, savedAt: 't', terminal: { shell: '/bin/bash', theme: 'dark' } },
      local: undefined
    }))
    writeShared = vi.fn(async () => true)
    updateLocal = vi.fn(async () => true)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      projectSettings: { read, writeShared, updateLocal },
      workspace: { save: vi.fn() }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('resolves local over shared with provenance', async () => {
    read.mockResolvedValue({
      shared: { version: 1, rev: 3, savedAt: 't', terminal: { shell: '/bin/bash', theme: 'dark' } },
      local: { terminal: { theme: 'light' } }
    })
    await mount()
    expect(hook.resolved.terminal.shell).toEqual({ value: '/bin/bash', source: 'shared' })
    expect(hook.resolved.terminal.theme).toEqual({ value: 'light', source: 'local' })
  })

  it('reports empty families while the read is still in flight', async () => {
    let release: (v: ProjectSettingsSnapshot) => void = () => {}
    read.mockReturnValue(new Promise<ProjectSettingsSnapshot>((r) => (release = r)))
    root = createRoot(host)
    act(() => {
      root.render(<Probe projectId="p1" />)
    })
    expect(hook.snapshot).toBe('loading')
    expect(hook.resolved).toEqual({ setup: {}, worktree: {}, agents: {}, terminal: {} })
    await act(async () => {
      release(EMPTY_SNAPSHOT)
    })
  })

  it('writes the WHOLE document (merging the edited field) and re-reads after a save', async () => {
    await mount()
    expect(read).toHaveBeenCalledTimes(1)
    let ok = false
    await act(async () => {
      ok = await hook.saveShared({ terminal: { shell: '/bin/fish' } })
    })
    expect(ok).toBe(true)
    // The sibling field survives, and version/rev/savedAt are stripped — the store owns those.
    expect(writeShared).toHaveBeenCalledTimes(1)
    expect(writeShared).toHaveBeenCalledWith('p1', { terminal: { shell: '/bin/fish', theme: 'dark' } })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('drops a field cleared to undefined, and the family with it', async () => {
    read.mockResolvedValue({
      shared: { version: 1, rev: 1, savedAt: 't', terminal: { shell: '/bin/bash' } },
      local: undefined
    })
    await mount()
    await act(async () => {
      await hook.saveShared({ terminal: { shell: undefined } })
    })
    expect(writeShared).toHaveBeenCalledWith('p1', {})
  })

  it('does not re-read when the write is refused', async () => {
    writeShared.mockResolvedValue(false)
    await mount()
    let ok = true
    await act(async () => {
      ok = await hook.saveShared({ terminal: { shell: '/bin/fish' } })
    })
    expect(ok).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('passes the local overlay through whole and re-reads', async () => {
    await mount()
    await act(async () => {
      await hook.saveLocal({ terminal: { shell: '/bin/zsh' }, ignoreShared: { agents: true } })
    })
    expect(updateLocal).toHaveBeenCalledWith('p1', {
      terminal: { shell: '/bin/zsh' },
      ignoreShared: { agents: true }
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('degrades a failed read to "nothing readable" instead of throwing', async () => {
    read.mockRejectedValue(new Error('boom'))
    await mount()
    expect(hook.snapshot).toBeNull()
    expect(hook.resolved.terminal.shell).toBeUndefined()
  })

  it('re-reads on reload()', async () => {
    await mount()
    await act(async () => {
      hook.reload()
    })
    expect(read).toHaveBeenCalledTimes(2)
  })
})
