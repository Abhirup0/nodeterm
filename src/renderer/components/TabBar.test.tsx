// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

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

async function load(): Promise<{
  TabBar: typeof import('./TabBar').TabBar
  useProjects: typeof import('../state/projects').useProjects
}> {
  const { TabBar } = await import('./TabBar')
  const { useProjects } = await import('../state/projects')
  return { TabBar, useProjects }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', memStorage())
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  Element.prototype.scrollIntoView = (): void => {}
  ;(window as unknown as { nodeTerminal: Record<string, never> }).nodeTerminal = {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('TabBar caret menu', () => {
  let root: Root
  let host: HTMLElement
  let onOpenProjectSettings: ReturnType<typeof vi.fn<(id: string) => void>>

  const menuButton = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-menu button')).find(
      (b) => b.textContent?.trim() === label
    )

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    onOpenProjectSettings = vi.fn<(id: string) => void>()
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={onOpenProjectSettings}
        />
      )
    })
    await click(host.querySelector<HTMLButtonElement>('.tab__caret')!)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('offers "Project settings…" and deep-links the project it was opened on', async () => {
    const item = menuButton('Project settings…')
    expect(item).toBeDefined()
    await click(item!)
    expect(onOpenProjectSettings).toHaveBeenCalledWith('p1')
    // …and the menu closes behind it, like every other action in this menu.
    expect(document.querySelector('.tab-menu')).toBeNull()
  })
})

describe('TabBar New-project pin', () => {
  let root: Root
  let host: HTMLElement
  let onOpenWelcome: ReturnType<typeof vi.fn<() => void>>

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({
      projects: [
        project({ id: 'p1', name: 'One' }),
        project({ id: 'p2', name: 'Two' }),
        project({ id: 'p3', name: 'Three' }),
        project({ id: 'p4', name: 'Four' })
      ],
      activeProjectId: 'p1'
    })
    onOpenWelcome = vi.fn()
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={onOpenWelcome}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
        />
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('keeps the + outside the scrolling tab strip', () => {
    const add = host.querySelector('.tab__add')
    const scroller = host.querySelector('.tabbar__tabs')
    expect(add).toBeTruthy()
    expect(scroller).toBeTruthy()
    expect(scroller!.contains(add)).toBe(false)
    expect(host.querySelector('.tabbar__projects')!.contains(add)).toBe(true)
  })

  it('opens the start screen from +', async () => {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.tab__add')!.click()
    })
    expect(onOpenWelcome).toHaveBeenCalledTimes(1)
  })
})
