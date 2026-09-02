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

describe('WelcomeScreen — Recently closed filter (issue #506)', () => {
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

  const many = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    name: i === 3 ? 'dot-github' : `Project ${i}`,
    cwd: `/repos/p${i}`
  }))

  const base = {
    onNewProject: noop,
    onOpenFolder: noop,
    onCloneRepo: noop,
    onConnectSsh: noop
  }

  const type = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('stays out of the way below the visible-row cap', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many.slice(0, 6)} />)
    expect(host.querySelector('.welcome__recent-filter')).toBeNull()
  })

  it('appears once the list is longer than the cap, and narrows by name', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many} />)
    const input = host.querySelector('.welcome__recent-filter') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(host.querySelectorAll('.welcome__recent-item')).toHaveLength(7)

    await type(input, 'dot-git')
    const rows = host.querySelectorAll('.welcome__recent-name')
    expect(Array.from(rows).map((r) => r.textContent)).toEqual(['dot-github'])
  })

  it('narrows by folder too — the row already renders it as the title', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many} />)
    const input = host.querySelector('.welcome__recent-filter') as HTMLInputElement
    await type(input, '/repos/p5')
    expect(host.querySelectorAll('.welcome__recent-item')).toHaveLength(1)
  })

  it('says nothing matched instead of rendering an empty list', async () => {
    await render(<WelcomeScreen {...base} closedProjects={many} />)
    const input = host.querySelector('.welcome__recent-filter') as HTMLInputElement
    await type(input, 'zzzz')
    expect(host.querySelectorAll('.welcome__recent-item')).toHaveLength(0)
    expect(host.querySelector('.welcome__recent-empty')!.textContent).toContain('zzzz')
  })

  it('the section itself stays hidden when there are no closed projects at all', async () => {
    await render(<WelcomeScreen {...base} closedProjects={[]} />)
    expect(host.querySelector('.welcome__recent')).toBeNull()
  })
})
