import { describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import {
  installKeydownIntercepts,
  keydownIntercept,
  type KeydownInterceptInput,
  type KeydownInterceptTarget
} from './keydown-intercept'

/**
 * BEHAVIOURAL. This replaces `menu-accelerator-intercepts.test.ts`, which asserted on the SOURCE
 * TEXT of `src/main/index.ts` (`expect(MAIN_SRC).toContain(...)`) and was therefore green on a tree
 * where a bare `0` keystroke was swallowed app-wide: the strings it matched were all still present,
 * because the guard that made them safe had moved out from under them. A test that reads the code
 * cannot see the code being *wrong*, only being *absent*.
 *
 * So: press keys, assert what happened. Two outcomes are observable and they are the two that
 * matter — did the window swallow the key (`preventDefault`, which takes it from the page AND the
 * default menu), and what did it forward to the renderer.
 *
 * The load-bearing half of this file is the refusals. Every chord here is built on a character
 * people type (`m`, `w`, `0`), so the difference between "intercepts ⌘0" and "intercepts 0" is one
 * modifier check and a completely unusable app.
 */

/** A `before-input-event` input with every flag off, overridable per case. */
function input(over: Partial<KeydownInterceptInput> = {}): KeydownInterceptInput {
  return {
    type: 'keyDown',
    key: '0',
    code: 'Digit0',
    meta: false,
    control: false,
    shift: false,
    alt: false,
    isAutoRepeat: false,
    ...over
  }
}

/**
 * Press a key at the real installation seam: register the handler on a fake window exactly as
 * `createWindow` does, then dispatch. Covers the wiring (`preventDefault` is called, the channel is
 * sent on `webContents`), not just the pure decision.
 */
function press(over: Partial<KeydownInterceptInput> = {}): { prevented: boolean; sent: string[] } {
  let handler:
    | ((event: { preventDefault(): void }, input: KeydownInterceptInput) => void)
    | null = null
  const sent: string[] = []
  const win: KeydownInterceptTarget = {
    webContents: {
      on: (_event, listener) => {
        handler = listener
      },
      send: (channel) => {
        sent.push(channel)
      }
    }
  }
  installKeydownIntercepts(win)
  if (!handler) throw new Error('installKeydownIntercepts registered no before-input-event listener')
  let prevented = false
  ;(handler as (e: { preventDefault(): void }, i: KeydownInterceptInput) => void)(
    { preventDefault: () => (prevented = true) },
    input(over)
  )
  return { prevented, sent }
}

/** Nothing happened at all: the page gets the key, and so does the menu if the page ignores it. */
const UNTOUCHED = { prevented: false, sent: [] }

describe('the main window refuses keys it does not claim', () => {
  // THE regression. #193 added the ⌘0 branch under a shared `meta || control` guard; a later
  // rewrite of that shared guard leaves `Digit0` with no modifier test of its own, and every
  // press of the zero key anywhere in the app is eaten and snaps the canvas to 100%.
  it('a bare 0 reaches the page', () => {
    expect(press()).toEqual(UNTOUCHED)
  })

  it('a bare m reaches the page', () => {
    expect(press({ key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
  })

  it('a bare w reaches the page', () => {
    expect(press({ key: 'w', code: 'KeyW' })).toEqual(UNTOUCHED)
  })

  // Shift and Alt are not primary modifiers: `)`, `M`, `W`, and every AltGr character on a non-US
  // layout are ordinary typing.
  it.each([
    ['Shift+0 — types ")"', { shift: true, key: ')' }],
    ['Alt+0 — AltGr territory', { alt: true }],
    ['Shift+M', { shift: true, key: 'M', code: 'KeyM' }],
    ['Alt+W', { alt: true, key: 'w', code: 'KeyW' }]
  ])('%s reaches the page', (_name, over) => {
    expect(press(over)).toEqual(UNTOUCHED)
  })

  it('an unclaimed chord (⌘K) reaches the page', () => {
    expect(press({ meta: true, key: 'k', code: 'KeyK' })).toEqual(UNTOUCHED)
  })

  it('keyUp is never intercepted, even for a claimed chord', () => {
    expect(press({ type: 'keyUp', meta: true })).toEqual(UNTOUCHED)
    expect(press({ type: 'keyUp', meta: true, key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
    expect(press({ type: 'keyUp', meta: true, key: 'w', code: 'KeyW' })).toEqual(UNTOUCHED)
  })
})

describe('⌘0 → canvas back to 100%', () => {
  it('is intercepted and forwarded', () => {
    expect(press({ meta: true })).toEqual({ prevented: true, sent: [IPC.appZoomActualSize] })
  })

  it('is intercepted under Ctrl too (Windows / Linux)', () => {
    expect(press({ control: true })).toEqual({ prevented: true, sent: [IPC.appZoomActualSize] })
  })

  // Matched on the physical key, so the chord survives a layout where the zero key prints
  // something else — the same rule the renderer's `zoomShortcutChord` follows.
  it('is matched on `code`, not the printed character', () => {
    expect(press({ meta: true, key: 'à' })).toEqual({
      prevented: true,
      sent: [IPC.appZoomActualSize]
    })
    // ...and only the digit row: the numpad zero is left to whatever else wants it.
    expect(press({ meta: true, code: 'Numpad0' })).toEqual(UNTOUCHED)
  })

  it('drops OS auto-repeat while still swallowing the key', () => {
    // Both halves matter. Forwarding a held ⌘0 would restart the 200ms zoom tween on every repeat;
    // letting it through would hand the repeat to the default menu's View ▸ Actual Size instead.
    expect(press({ meta: true, isAutoRepeat: true })).toEqual({ prevented: true, sent: [] })
  })

  it('is not claimed with Shift or Alt added', () => {
    expect(press({ meta: true, shift: true })).toEqual(UNTOUCHED)
    expect(press({ meta: true, alt: true })).toEqual(UNTOUCHED)
  })
})

describe('⌘M → markdown view, stolen back from Window ▸ Minimize', () => {
  it('is intercepted and forwarded', () => {
    expect(press({ meta: true, key: 'm', code: 'KeyM' })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
    expect(press({ control: true, key: 'm', code: 'KeyM' })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
  })

  // The shipped breadth of this branch: unlike ⌘W and ⌘0 it tests no Shift/Alt, so ⌘⇧M and ⌘⌥M
  // toggle too. Pinned as-is — narrowing it is a real behaviour change (⌘⇧M would go back to the
  // menu) and should turn this red on purpose rather than slip through.
  it('also claims ⌘⇧M and ⌘⌥M', () => {
    expect(press({ meta: true, shift: true, key: 'M', code: 'KeyM' })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
    expect(press({ meta: true, alt: true, key: 'm', code: 'KeyM' })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
  })

  it('repeats keep toggling (no auto-repeat rule here, unlike ⌘0)', () => {
    expect(press({ meta: true, key: 'm', code: 'KeyM', isAutoRepeat: true })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
  })
})

describe('⌘W → close the selected node, stolen back from Window ▸ Close', () => {
  it('is intercepted and forwarded', () => {
    expect(press({ meta: true, key: 'w', code: 'KeyW' })).toEqual({
      prevented: true,
      sent: [IPC.appCloseNode]
    })
    expect(press({ control: true, key: 'w', code: 'KeyW' })).toEqual({
      prevented: true,
      sent: [IPC.appCloseNode]
    })
  })

  it('leaves ⌘⇧W to the menu (Close All Windows)', () => {
    expect(press({ meta: true, shift: true, key: 'W', code: 'KeyW' })).toEqual(UNTOUCHED)
  })
})

describe('the decision is pure', () => {
  // Same function, called directly: a caller that is not a BrowserWindow (a future menu, a test,
  // the next intercept) gets the same answer, and `null` unambiguously means "not ours".
  it('returns null for anything unclaimed and an action for a claimed chord', () => {
    expect(keydownIntercept(input())).toBeNull()
    expect(keydownIntercept(input({ meta: true }))).toEqual({ action: 'zoom-actual-size' })
    expect(keydownIntercept(input({ meta: true, isAutoRepeat: true }))).toEqual({ action: null })
  })
})
