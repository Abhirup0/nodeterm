// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import { useProjects } from '../state/projects'
import { TabBar } from './TabBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
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

describe('TabBar caret menu', () => {
  let root: Root
  let host: HTMLElement
  let onOpenProjectSettings: ReturnType<typeof vi.fn<(id: string) => void>>

  const click = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const menuButton = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-menu button')).find(
      (b) => b.textContent?.trim() === label
    )

  beforeEach(async () => {
    // jsdom implements neither; TabBar uses both purely for presentation.
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
    Element.prototype.scrollIntoView = (): void => {}
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {}
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
    useProjects.setState({ projects: [], activeProjectId: '' })
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
