import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setMainWindow, getMainWindow, sendToMain, shouldHideOnClose, type MainWindowLike } from './main-window'

function fakeWindow(): MainWindowLike & {
  sent: [string, ...unknown[]][]
  destroy(): void
  emitClosed(): void
} {
  let destroyed = false
  const closedListeners: (() => void)[] = []
  const sent: [string, ...unknown[]][] = []
  return {
    sent,
    isDestroyed: () => destroyed,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    on: (event: 'closed', cb: () => void) => {
      if (event === 'closed') closedListeners.push(cb)
    },
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args])
      }
    },
    destroy() {
      destroyed = true
    },
    emitClosed() {
      closedListeners.forEach((cb) => cb())
    }
  }
}

describe('main-window tracking', () => {
  beforeEach(() => {
    // Reset module state between tests: register a fresh window then let it close.
    const w = fakeWindow()
    setMainWindow(w)
    w.destroy()
    w.emitClosed()
  })

  it('sendToMain delivers to the registered window', () => {
    const w = fakeWindow()
    setMainWindow(w)
    sendToMain('agent:status', { nodeId: 'n1' })
    expect(w.sent).toEqual([['agent:status', { nodeId: 'n1' }]])
  })

  it('sendToMain is a silent no-op once the window is destroyed', () => {
    const w = fakeWindow()
    setMainWindow(w)
    w.destroy()
    expect(() => sendToMain('agent:status', {})).not.toThrow()
    expect(w.sent).toEqual([])
    expect(getMainWindow()).toBeNull()
  })

  // The original bug: hook events were bound to the FIRST window via closure, so after
  // the macOS close→dock-reopen cycle every agent:status event was dropped forever.
  it('sendToMain reaches a replacement window registered after the first one died', () => {
    const first = fakeWindow()
    setMainWindow(first)
    first.destroy()
    first.emitClosed()

    const second = fakeWindow()
    setMainWindow(second)
    sendToMain('agent:status', { state: 'working' })

    expect(first.sent).toEqual([])
    expect(second.sent).toEqual([['agent:status', { state: 'working' }]])
    expect(getMainWindow()).toBe(second)
  })

  it("a stale 'closed' from the old window does not clear a newer registration", () => {
    const first = fakeWindow()
    setMainWindow(first)
    const second = fakeWindow()
    setMainWindow(second)
    first.emitClosed() // old window's closed event arrives late
    expect(getMainWindow()).toBe(second)
  })

  it('getMainWindow returns null when nothing was registered or after closed', () => {
    const w = fakeWindow()
    setMainWindow(w)
    w.emitClosed()
    expect(getMainWindow()).toBeNull()
  })
})

describe('shouldHideOnClose', () => {
  it('hides instead of closing on macOS while the app is not quitting', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(true)
  })
  it('lets the close through when the app is quitting', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false)
  })
  it('never intercepts close on other platforms', () => {
    expect(shouldHideOnClose('win32', false)).toBe(false)
    expect(shouldHideOnClose('linux', false)).toBe(false)
  })
})
