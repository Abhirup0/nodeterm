// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MemInfo, Project } from '@shared/types'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import { useSessionMemory } from '../state/sessionMemory'
import { SystemResourcePill } from './SystemResourcePill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'p',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

const sshProject = (): Project =>
  project({ id: 'ssh1', ssh: { server: { host: 'box', user: 'enes', port: 22 } as never, remoteCwd: '/srv' } })

/**
 * The FIXTURE is the whole test. `used = totalMb - availableMb` must be distinguishable from every
 * other number in the object, or a component that printed `availableMb` (or `totalMb`) would pass:
 * total 64000, available 48000 ⇒ used 16000, and 15.6 / 46.9 / 62.5 GB are three different strings.
 */
const MEM: MemInfo = { totalMb: 64000, availableMb: 48000 }

let host: HTMLDivElement
let root: Root
let startHostPoll: Mock<(scopeKey: string, projectId?: string) => void>
let stopHostPoll: Mock<() => void>

/** Mount with the store's poll actions stubbed — the real ones would talk to a session registry
 *  that does not exist in a jsdom test, and `refreshHost` would clear the `mem` fixture on the way
 *  through `enterScope`. */
function mount(mem: MemInfo | null, overBoard = false): void {
  useSessionMemory.setState({ mem, startHostPoll, stopHostPoll })
  host = document.createElement('div')
  root = createRoot(host)
  act(() => root.render(<SystemResourcePill overBoard={overBoard} />))
}

beforeEach(() => {
  startHostPoll = vi.fn<(scopeKey: string, projectId?: string) => void>()
  stopHostPoll = vi.fn<() => void>()
  useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
  useSshConn.setState({ byProject: {} })
})

afterEach(() => {
  act(() => root.unmount())
})

describe('SystemResourcePill', () => {
  it('renders used / total, never the available or total figure alone', () => {
    mount(MEM)
    const pill = host.querySelector('.sysres-pill')
    expect(pill?.textContent).toContain('15.6 GB')
    expect(pill?.textContent).toContain('62.5 GB')
    expect(pill?.textContent).not.toContain('46.9 GB')
  })

  it('fills the bar by memory USED, not by what is free', () => {
    mount(MEM)
    const fill = host.querySelector<HTMLElement>('.sysres-pill__minibar-fill')
    expect(fill?.style.width).toBe('25%')
  })

  it('pulses instead of claiming a number when the reading is null', () => {
    mount(null)
    const pill = host.querySelector('.sysres-pill')
    expect(pill).not.toBeNull()
    expect(host.querySelector('.sysres-pill__pulse')).not.toBeNull()
    // The one thing this pill must never say. `0 GB` is the shape a confident zero takes, but so
    // is any digit at all — there is no number we are entitled to print without a reading.
    expect(pill?.textContent).not.toMatch(/\d/)
    expect(pill?.textContent).not.toContain('GB')
    expect(host.querySelector('.sysres-pill__minibar')).toBeNull()
  })

  it('treats a zero total as unreadable rather than dividing by it', () => {
    mount({ totalMb: 0, availableMb: 0 })
    expect(host.querySelector('.sysres-pill__pulse')).not.toBeNull()
    expect(host.querySelector('.sysres-pill')?.textContent).not.toMatch(/\d/)
  })

  it('starts the host poll for the active project and stops it on unmount', () => {
    mount(MEM)
    expect(startHostPoll).toHaveBeenCalledTimes(1)
    // Explicit project id — the store's `activeSessionApi()` fallback is the only path that can
    // address the wrong machine.
    expect(startHostPoll).toHaveBeenCalledWith('', 'p1')
    act(() => root.unmount())
    expect(stopHostPoll).toHaveBeenCalledTimes(1)
    // The afterEach unmount must not throw on an already-unmounted root.
    root = createRoot(document.createElement('div'))
  })

  it('polls an SSH project under its HOST key, never the local scope', () => {
    useProjects.setState({ projects: [sshProject()], activeProjectId: 'ssh1' })
    mount(MEM)
    expect(startHostPoll).toHaveBeenCalledWith('enes@box', 'ssh1')
  })

  it('re-reads when the SSH project connection comes up', () => {
    useProjects.setState({ projects: [sshProject()], activeProjectId: 'ssh1' })
    mount(MEM)
    expect(startHostPoll).toHaveBeenCalledTimes(1)
    // An SSH scope is read ONCE with no timer behind it, so a first read that landed before the
    // ControlMaster was up would leave the pill blank until the panel was opened.
    act(() => {
      useSshConn.setState({ byProject: { ssh1: { controlPath: '/tmp/cm' } } })
    })
    expect(startHostPoll).toHaveBeenCalledTimes(2)
    expect(startHostPoll).toHaveBeenLastCalledWith('enes@box', 'ssh1')
  })

  it('renders nothing and polls nothing without an active project', () => {
    useProjects.setState({ projects: [], activeProjectId: '' })
    mount(MEM)
    expect(host.querySelector('.sysres-pill')).toBeNull()
    expect(startHostPoll).not.toHaveBeenCalled()
  })

  it('rises above the kanban overlay only when the board is open', () => {
    mount(MEM, true)
    expect(host.querySelector('.sysres-indicator--board')).not.toBeNull()
    act(() => root.unmount())
    mount(MEM, false)
    expect(host.querySelector('.sysres-indicator--board')).toBeNull()
  })

  it('toggles its open state — the pill is the panel´s only entry point', () => {
    mount(MEM)
    const pill = host.querySelector<HTMLButtonElement>('.sysres-pill')!
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    act(() => pill.click())
    expect(host.querySelector('.sysres-pill')?.getAttribute('aria-expanded')).toBe('true')
    act(() => host.querySelector<HTMLButtonElement>('.sysres-pill')!.click())
    expect(host.querySelector('.sysres-pill')?.getAttribute('aria-expanded')).toBe('false')
  })
})
