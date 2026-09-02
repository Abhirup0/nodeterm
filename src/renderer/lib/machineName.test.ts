import { afterEach, describe, expect, it, vi } from 'vitest'

const browser = vi.hoisted(() => ({ value: false }))
vi.mock('../bridge/runtime', () => ({ isBrowserRuntime: () => browser.value }))

import { machineNoun, otherMachines, thisMachine, thisMachineCap } from './machineName'

const on = (platform: string, isBrowser = false): void => {
  browser.value = isBrowser
  vi.stubGlobal('navigator', { platform, userAgent: platform })
}

afterEach(() => {
  browser.value = false
  vi.unstubAllGlobals()
})

describe('machineNoun', () => {
  it('names the machine the desktop app is actually running on', () => {
    on('MacIntel')
    expect(machineNoun()).toBe('Mac')
    on('Win32')
    expect(machineNoun()).toBe('PC')
    on('Linux x86_64')
    expect(machineNoun()).toBe('computer')
  })

  // Issue #563: the license, seats and sessions a Server Edition tab describes belong to the
  // SERVER, whose OS the viewer's navigator says nothing about. A neutral word is the honest
  // answer there; "This Mac" for a Mac browsing a Linux server is a confident wrong one.
  it('stays neutral in a browser tab, whatever the VIEWER runs', () => {
    on('MacIntel', true)
    expect(machineNoun()).toBe('computer')
    on('Win32', true)
    expect(machineNoun()).toBe('computer')
  })

  it('stays neutral with no navigator at all', () => {
    browser.value = false
    vi.stubGlobal('navigator', undefined)
    expect(machineNoun()).toBe('computer')
  })
})

describe('the sentence forms', () => {
  it('reads correctly mid-sentence, at a sentence start and in the plural', () => {
    on('Win32')
    expect(thisMachine()).toBe('this PC')
    expect(thisMachineCap()).toBe('This PC')
    expect(otherMachines()).toBe('other PCs')
    on('MacIntel')
    expect(thisMachine()).toBe('this Mac')
    expect(thisMachineCap()).toBe('This Mac')
    expect(otherMachines()).toBe('other Macs')
    on('Linux x86_64')
    expect(otherMachines()).toBe('other computers')
  })
})
