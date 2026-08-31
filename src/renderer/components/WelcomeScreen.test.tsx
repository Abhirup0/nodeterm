// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomeScreen } from './WelcomeScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}

describe('WelcomeScreen — Recently closed session badges (issue #442)', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }

  const base = {
    onNewProject: noop,
    onOpenFolder: noop,
    onCloneRepo: noop,
    onConnectSsh: noop,
    closedProjects: [
      { id: 'p1', name: 'Web', cwd: '/w' },
      { id: 'p2', name: 'API', cwd: '/a' }
    ]
  }

  it('shows a live-session badge only for projects the sweep counted', async () => {
    await render(<WelcomeScreen {...base} sessionCounts={{ p1: 3 }} />)
    const badges = host.querySelectorAll('.welcome__recent-sessions')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('3 running')
    // The tooltip carries what the badge means — parked sessions still running on this machine.
    expect(badges[0].getAttribute('title')).toContain('still running on this machine')
  })

  it('shows NO badge when counts were not measured — a failed sweep is not "0"', async () => {
    await render(<WelcomeScreen {...base} />)
    expect(host.querySelectorAll('.welcome__recent-sessions')).toHaveLength(0)
  })

  it('the × routes through onDeleteClosed without also triggering the row reopen', async () => {
    const onReopen = vi.fn()
    const onDeleteClosed = vi.fn()
    await render(<WelcomeScreen {...base} onReopen={onReopen} onDeleteClosed={onDeleteClosed} />)
    const del = host.querySelector('.welcome__recent-del') as HTMLButtonElement
    act(() => del.click())
    expect(onDeleteClosed).toHaveBeenCalledWith('p1')
    expect(onReopen).not.toHaveBeenCalled()
  })
})
