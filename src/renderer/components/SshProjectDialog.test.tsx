// @vitest-environment jsdom
//
// The renderer half of the browse-master cancel fix (the manager half lives in
// ssh-project.test.ts). What must hold: from the moment connect() is ISSUED, closing or
// unmounting the dialog tears the throwaway browse master down. Marking the master for
// teardown only after a successful connect meant cancelling during 'connecting' skipped
// disconnect entirely, and a slow or passphrase-parked attempt then landed unowned and
// lived for the rest of the app run.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshProjectDialog } from './SshProjectDialog'
import { useSshServers } from '../state/sshServers'
import type { SshServer } from '@shared/ssh'

// React refuses act() outside a configured test environment without this flag.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVER: SshServer = { id: 's1', label: 'testbox', host: 'h.example.com', user: 'u' }

describe('SshProjectDialog browse-master teardown', () => {
  let root: Root | undefined
  let host: HTMLElement
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    connect = vi.fn(() => new Promise(() => {})) // never settles: the dialog parks in 'connecting'
    disconnect = vi.fn(async () => {})
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      sshProject: {
        connect,
        disconnect,
        listDir: vi.fn(async () => ({ path: '~', dirs: [] })),
        mkdir: vi.fn(async () => true)
      }
    }
    useSshServers.setState({ servers: [SERVER] })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
  })

  function render(): ReturnType<typeof vi.fn> {
    const onClose = vi.fn()
    root = createRoot(host)
    act(() => {
      root!.render(<SshProjectDialog onCreate={vi.fn()} onManage={vi.fn()} onClose={onClose} />)
    })
    return onClose
  }

  const click = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const buttonByText = (text: string): HTMLButtonElement => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes(text))
    if (!b) throw new Error(`no button containing "${text}"`)
    return b
  }

  it('cancelling DURING connecting still tears the browse master down (mark-before-await)', () => {
    const onClose = render()
    click(buttonByText('testbox')) // issues connect(); the promise never settles
    expect(connect).toHaveBeenCalledTimes(1)
    const browseId = connect.mock.calls[0][0] as string
    expect(browseId).toMatch(/^ssh-browse-/)
    expect(disconnect).not.toHaveBeenCalled()
    click(buttonByText('Cancel')) // the connecting step's Cancel button
    expect(disconnect).toHaveBeenCalledWith(browseId)
    expect(onClose).toHaveBeenCalled()
  })

  it('unmounting mid-connect tears it down too (the effect-cleanup path)', () => {
    render()
    click(buttonByText('testbox'))
    const browseId = connect.mock.calls[0][0] as string
    act(() => root!.unmount())
    root = undefined
    expect(disconnect).toHaveBeenCalledWith(browseId)
  })

  it('closing without ever connecting disconnects nothing', () => {
    const onClose = render()
    click(buttonByText('Cancel')) // the pick step's Cancel: no connect was ever issued
    expect(disconnect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
