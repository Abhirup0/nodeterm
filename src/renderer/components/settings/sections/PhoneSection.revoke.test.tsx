// @vitest-environment jsdom
//
// Settings → Phone, the Revoke button: which of the three revoke outcomes the user is TOLD about.
// The rule is asymmetric on purpose — 'skipped' is a normal state (a free-tier desktop holds no
// entitlement to revoke with, and a phone paired before we recorded its relay id has no row we can
// name), so warning there would tell a free user their phone's Pro is stuck when it never had any.
// Only a leg that actually failed may warn, and a failed one always must.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DeviceRevokeResult, PairedDevice } from '@shared/types'
import { PhoneSection } from './PhoneSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEVICE: PairedDevice = {
  id: 'dev-a',
  name: 'Enes’ iPhone',
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 0,
  relayDeviceId: 'phone-relay-1'
}

let root: Root
let host: HTMLElement
let revokeDevice: ReturnType<typeof vi.fn>

/** The narrow slice of `window.nodeTerminal` this section touches on mount + revoke. */
function stubBridge(result: DeviceRevokeResult | Error): void {
  revokeDevice = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn(() => () => undefined),
      probeSsh: vi.fn(async () => true),
      openRemoteLoginSettings: vi.fn(),
      listDevices: vi.fn(async () => [DEVICE]),
      revokeDevice
    },
    remoteHost: { setPhoneAccess: vi.fn() },
    shell: { openExternal: vi.fn() }
  }
}

function button(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  )
  expect(el, `a rendered "${label}" button`).toBeTruthy()
  return el as HTMLButtonElement
}

/** Click Revoke → confirm → let the (async) revoke settle. Returns the section's visible text. */
async function revokeFlow(): Promise<string> {
  await act(async () => {
    button('Revoke').click()
  })
  await act(async () => {
    // The ConfirmDialog's own confirm button carries the same label; it portals onto body last.
    const confirms = [...document.body.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Revoke'
    )
    confirms[confirms.length - 1].click()
  })
  await act(async () => undefined)
  return host.textContent ?? ''
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function mount(): void {
  act(() => root.render(<PhoneSection isActive />))
}

describe('PhoneSection revoke feedback', () => {
  it('says nothing when the server leg was skipped — there was nothing of ours to revoke', async () => {
    stubBridge({ local: true, server: 'skipped' })
    mount()
    await act(async () => undefined) // the mount-time listDevices

    const text = await revokeFlow()
    expect(revokeDevice).toHaveBeenCalledWith('dev-a')
    expect(text).not.toMatch(/Pro access/i)
    expect(text).not.toMatch(/try again/i)
  })

  it('says nothing on a clean revoke', async () => {
    stubBridge({ local: true, server: 'ok' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).not.toMatch(/Pro access/i)
    expect(text).not.toMatch(/try again/i)
  })

  it('warns that the phone kept its Pro when the server leg failed', async () => {
    stubBridge({ local: true, server: 'failed' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toMatch(/Pro access/i)
    expect(text).toMatch(/try again/i)
  })

  it('warns about the local removal when that is the leg that failed', async () => {
    stubBridge({ local: false, server: 'ok' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    // The device is still on this machine — saying "its Pro could not be revoked" would be a
    // different (and here untrue) story.
    expect(text).toMatch(/remove/i)
    expect(text).toMatch(/try again/i)
    expect(text).not.toMatch(/Pro access/i)
  })

  it('warns when the call itself never answered', async () => {
    stubBridge(new Error('E_UNSUPPORTED'))
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toMatch(/try again/i)
  })
})
