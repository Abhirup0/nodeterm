// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardMiddleClickPaste, suppressMiddleClickPaste } from './middle-click'

/**
 * Issue #84: on Linux a middle click inside a terminal pasted text into the pty with no way to
 * switch it off. Measured on the reporting machine, the paste happens DOWNSTREAM of the pty (tmux's
 * `MouseDown2Pane` at a shell prompt; the agent TUI itself reading X PRIMARY), consuming the mouse
 * report xterm forwards — so the fix is to stop the DOM event from ever reaching xterm's listeners,
 * not to cancel a browser default that does not exist. `preventDefault` alone shipped once and was
 * confirmed inert on device.
 */
describe('suppressMiddleClickPaste', () => {
  it('suppresses the middle button while the setting is off', () => {
    expect(suppressMiddleClickPaste(1, false)).toBe(true)
  })

  it('lets the middle button through once the user opts in', () => {
    expect(suppressMiddleClickPaste(1, true)).toBe(false)
  })

  it('never touches the other buttons', () => {
    // Left is selection and focus; right is the context menu. Swallowing either would break the
    // terminal in a far more visible way than the bug being fixed.
    for (const button of [0, 2, 3, 4]) {
      expect(suppressMiddleClickPaste(button, false)).toBe(false)
      expect(suppressMiddleClickPaste(button, true)).toBe(false)
    }
  })
})

/**
 * The guard's contract is that xterm — whose listeners live on DESCENDANTS of the host — never
 * sees a suppressed event, because an unseen event produces no mouse report and therefore no
 * paste anywhere downstream. That is a propagation fact, so it is pinned with a real DOM.
 */
describe('guardMiddleClickPaste', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function mount(allow: boolean): { child: HTMLElement; host: HTMLElement; seen: string[] } {
    const host = document.createElement('div')
    // Stands in for xterm's screen element, where its own mouse listeners are attached.
    const child = document.createElement('div')
    host.appendChild(child)
    document.body.appendChild(host)
    const off = guardMiddleClickPaste(host, () => allow)
    const seen: string[] = []
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      child.addEventListener(type, (e) => seen.push(`${type}:${(e as MouseEvent).button}`))
    }
    cleanups.push(() => {
      off()
      host.remove()
    })
    return { child, host, seen }
  }

  function press(target: HTMLElement, button: number): MouseEvent[] {
    const events = ['mousedown', 'mouseup', 'auxclick'].map(
      (type) => new MouseEvent(type, { bubbles: true, cancelable: true, button })
    )
    for (const e of events) target.dispatchEvent(e)
    return events
  }

  it('a suppressed middle click never reaches listeners below the host', () => {
    const { child, seen } = mount(false)
    const events = press(child, 1)
    expect(seen).toEqual([])
    // preventDefault is kept for the (unmeasured) setups where a genuine browser paste exists.
    for (const e of events) expect(e.defaultPrevented).toBe(true)
  })

  it('silences later listeners on the host itself, not only descendants', () => {
    const { child, host } = mount(false)
    // Registered AFTER the guard, same element, same capture phase — only
    // stopImmediatePropagation covers this one.
    const late = vi.fn()
    host.addEventListener('mousedown', late, true)
    cleanups.push(() => host.removeEventListener('mousedown', late, true))
    press(child, 1)
    expect(late).not.toHaveBeenCalled()
  })

  it('lets the middle button through once the user opts in', () => {
    const { child, seen } = mount(true)
    const events = press(child, 1)
    expect(seen).toEqual(['mousedown:1', 'mouseup:1', 'auxclick:1'])
    for (const e of events) expect(e.defaultPrevented).toBe(false)
  })

  it('never touches the other buttons', () => {
    const { child, seen } = mount(false)
    press(child, 0)
    press(child, 2)
    expect(seen).toEqual([
      'mousedown:0',
      'mouseup:0',
      'auxclick:0',
      'mousedown:2',
      'mouseup:2',
      'auxclick:2'
    ])
  })

  it('the returned unsubscribe removes the guard', () => {
    const host = document.createElement('div')
    const child = document.createElement('div')
    host.appendChild(child)
    document.body.appendChild(host)
    const off = guardMiddleClickPaste(host, () => false)
    off()
    const seen: string[] = []
    child.addEventListener('mousedown', () => seen.push('mousedown'))
    cleanups.push(() => host.remove())
    press(child, 1)
    expect(seen).toEqual(['mousedown'])
  })
})
