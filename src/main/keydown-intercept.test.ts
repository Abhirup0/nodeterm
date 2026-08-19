import { describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import { MAIN_INTERCEPTED_COMMAND_IDS } from '../shared/keybindings'
import {
  installKeydownIntercepts,
  keydownIntercept,
  resolveInterceptBindings,
  type KeydownInterceptBindings,
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

/** The shipped bindings, per platform. `node.close` / `node.toggleMarkdown` default to `Cmd+W` /
 *  `Cmd+M` on both, but `Cmd` RESOLVES differently — ⌘ on mac, Control elsewhere — which is what
 *  makes `press(…, { isMac: false })` below the Windows/Linux run of the same chord. */
const DEFAULTS = resolveInterceptBindings(undefined, true)
const DEFAULTS_PC = resolveInterceptBindings(undefined, false)

/**
 * Press a key at the real installation seam: register the handler on a fake window exactly as
 * `createWindow` does, then dispatch. Covers the wiring (`preventDefault` is called, the channel is
 * sent on `webContents`), not just the pure decision.
 */
function press(
  over: Partial<KeydownInterceptInput> = {},
  opts: { bindings?: KeydownInterceptBindings; isMac?: boolean } = {}
): { prevented: boolean; sent: string[] } {
  const isMac = opts.isMac ?? true
  const bindings = opts.bindings ?? (isMac ? DEFAULTS : DEFAULTS_PC)
  // Not recording: the ordinary state of the app, and the baseline every case below asserts
  // against. The armed state has its own describe block at the bottom of this file.
  const seam = install(() => bindings, isMac, () => false)
  seam.fire(over)
  return { prevented: seam.prevented.length > 0, sent: seam.sent }
}

/**
 * ONE installation whose listener can be fired repeatedly — the shape a live window has, and the
 * only way to press the same key on both sides of a state change (the recording bit flipping under
 * a running window is exactly what `press`, which installs per call, cannot show).
 */
function install(
  getBindings: () => KeydownInterceptBindings,
  isMac: boolean,
  isRecording: () => boolean
): { fire: (over?: Partial<KeydownInterceptInput>) => void; prevented: string[]; sent: string[] } {
  let handler:
    | ((event: { preventDefault(): void }, input: KeydownInterceptInput) => void)
    | null = null
  const sent: string[] = []
  const prevented: string[] = []
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
  installKeydownIntercepts(win, getBindings, isMac, isRecording)
  if (!handler) throw new Error('installKeydownIntercepts registered no before-input-event listener')
  const fire = (over: Partial<KeydownInterceptInput> = {}): void => {
    const i = input(over)
    ;(handler as (e: { preventDefault(): void }, i: KeydownInterceptInput) => void)(
      { preventDefault: () => prevented.push(i.code) },
      i
    )
  }
  return { fire, prevented, sent }
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
    expect(press({ control: true }, { isMac: false })).toEqual({
      prevented: true,
      sent: [IPC.appZoomActualSize]
    })
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
    // Windows / Linux: the same `Cmd+M` binding resolves to Control there.
    expect(press({ control: true, key: 'm', code: 'KeyM' }, { isMac: false })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
  })

  // D-STRICT DELTA (named in the PR body). The old branch was `key === 'm'` under a
  // `meta || control` guard, so ⌘⇧M, ⌘⌥M and — on mac — ⌃M all toggled too. Matching a real
  // binding is exact on all four modifier flags, so each of those is now a different chord and
  // goes back to the page/menu. This is the behaviour change; assert it rather than leave it to
  // a reader of the diff.
  it('no longer claims ⌘⇧M, ⌘⌥M, or ⌃M on mac', () => {
    expect(press({ meta: true, shift: true, key: 'M', code: 'KeyM' })).toEqual(UNTOUCHED)
    expect(press({ meta: true, alt: true, key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
    expect(press({ control: true, key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
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
    expect(press({ control: true, key: 'w', code: 'KeyW' }, { isMac: false })).toEqual({
      prevented: true,
      sent: [IPC.appCloseNode]
    })
  })

  it('leaves ⌘⇧W to the menu (Close All Windows)', () => {
    expect(press({ meta: true, shift: true, key: 'W', code: 'KeyW' })).toEqual(UNTOUCHED)
  })

  // Same D-strict delta as ⌘M's: ⌃W was swallowed app-wide on mac (where it is readline's
  // delete-word, not a menu accelerator) and now reaches the page.
  it('no longer claims ⌃W on mac', () => {
    expect(press({ control: true, key: 'w', code: 'KeyW' })).toEqual(UNTOUCHED)
  })
})

describe('the decision is pure', () => {
  // Same function, called directly: a caller that is not a BrowserWindow (a future menu, a test,
  // the next intercept) gets the same answer, and `null` unambiguously means "not ours".
  it('returns null for anything unclaimed and an action for a claimed chord', () => {
    expect(keydownIntercept(input(), DEFAULTS, true)).toBeNull()
    expect(keydownIntercept(input({ meta: true }), DEFAULTS, true)).toEqual({
      action: 'zoom-actual-size'
    })
    expect(keydownIntercept(input({ meta: true, isAutoRepeat: true }), DEFAULTS, true)).toEqual({
      action: null
    })
  })
})

describe('binding-driven intercept', () => {
  it('defaults reproduce today: Cmd+M and Cmd+W intercept, Shift variants do not', () => {
    expect(keydownIntercept(input({ meta: true, key: 'm', code: 'KeyM' }), DEFAULTS, true)).toEqual({
      action: 'toggle-markdown'
    })
    expect(keydownIntercept(input({ meta: true, key: 'w', code: 'KeyW' }), DEFAULTS, true)).toEqual({
      action: 'close-node'
    })
    expect(keydownIntercept(input({ meta: true, shift: true, key: 'w', code: 'KeyW' }), DEFAULTS, true)).toBeNull()
    // D-strict delta, named in the PR body: ⌘⇧M no longer intercepts (old code ignored shift on m).
    expect(keydownIntercept(input({ meta: true, shift: true, key: 'm', code: 'KeyM' }), DEFAULTS, true)).toBeNull()
  })

  it('an unbound command stops intercepting (Electron default returns)', () => {
    const unbound = resolveInterceptBindings({ 'node.close': [] }, true)
    expect(keydownIntercept(input({ meta: true, key: 'w', code: 'KeyW' }), unbound, true)).toBeNull()
    expect(keydownIntercept(input({ meta: true, key: 'm', code: 'KeyM' }), unbound, true)).toEqual({
      action: 'toggle-markdown'
    })
  })

  it('a remap moves the interception', () => {
    const remapped = resolveInterceptBindings({ 'node.toggleMarkdown': ['Cmd+Shift+M'] }, true)
    expect(keydownIntercept(input({ meta: true, key: 'm', code: 'KeyM' }), remapped, true)).toBeNull()
    expect(keydownIntercept(input({ meta: true, shift: true, key: 'm', code: 'KeyM' }), remapped, true)).toEqual({
      action: 'toggle-markdown'
    })
  })

  // The reason the primary-modifier half of the old shared gate could NOT stay where it was: an
  // Alt-only chord is a valid binding per the registry's rules, this intercept is its only
  // dispatcher (the chord never reaches the renderer — the page does not see a claimed key), so a
  // `meta || control` gate above the matchers would make the remap dead everywhere with no error.
  // Pressed with **isMac: false** on purpose: `Alt+M` is a Windows/Linux chord. macOS composes
  // Option+letter into a character (⌥M reports `key: 'µ'`), so this exact remap could not fire
  // there whatever this module did — mac's stake in the gate is Alt+non-letter (F-keys, arrows).
  it('an Alt-only remap fires off-mac, and the bare key still does not', () => {
    const alt = resolveInterceptBindings({ 'node.toggleMarkdown': ['Alt+M'] }, false)
    expect(keydownIntercept(input({ alt: true, key: 'm', code: 'KeyM' }), alt, false)).toEqual({
      action: 'toggle-markdown'
    })
    expect(keydownIntercept(input({ key: 'm', code: 'KeyM' }), alt, false)).toBeNull()
  })

  // The mac half of the same gate, on a key macOS does NOT compose: ⌥F5 stays `key: 'F5'`.
  it('a mac Alt+non-letter remap fires (what Option composition leaves reachable there)', () => {
    const alt = resolveInterceptBindings({ 'node.toggleMarkdown': ['Alt+F5'] }, true)
    expect(keydownIntercept(input({ alt: true, key: 'F5', code: 'F5' }), alt, true)).toEqual({
      action: 'toggle-markdown'
    })
    expect(keydownIntercept(input({ key: 'F5', code: 'F5' }), alt, true)).toBeNull()
  })

  it('garbage overrides fall back to defaults', () => {
    expect(resolveInterceptBindings({ 'node.close': ['garbage+++'] }, true)).toEqual(DEFAULTS)
  })

  it('the Digit0 zoom gesture is untouched by bindings', () => {
    const unbound = resolveInterceptBindings({ 'node.close': [], 'node.toggleMarkdown': [] }, true)
    expect(keydownIntercept(input({ meta: true, code: 'Digit0' }), unbound, true)).toEqual({
      action: 'zoom-actual-size'
    })
    // ...and it keeps the primary-modifier requirement it used to inherit from the shared gate.
    expect(keydownIntercept(input({ code: 'Digit0' }), unbound, true)).toBeNull()
  })

  it('a remapped binding is dispatched at the install seam too', () => {
    const remapped = resolveInterceptBindings({ 'node.close': ['Cmd+Shift+K'] }, true)
    expect(press({ meta: true, shift: true, key: 'K', code: 'KeyK' }, { bindings: remapped })).toEqual(
      { prevented: true, sent: [IPC.appCloseNode] }
    )
    expect(press({ meta: true, key: 'w', code: 'KeyW' }, { bindings: remapped })).toEqual(UNTOUCHED)
  })

  // LIST DRIFT. `MAIN_INTERCEPTED_COMMAND_IDS` is what the Settings UI checks a candidate binding
  // against for the app-wide shadow warning (`findMainInterceptShadowing`), and nothing else ties
  // it to the commands THIS module actually resolves. A third intercept added here without the id
  // added there would be swallowed app-wide with the recorder cheerfully reporting no conflict.
  it('MAIN_INTERCEPTED_COMMAND_IDS is exactly the set this module resolves', () => {
    expect(Object.keys(DEFAULTS)).toHaveLength(MAIN_INTERCEPTED_COMMAND_IDS.length)
    // Unbinding a listed command must visibly change what this module resolves — i.e. it is read
    // here, not merely claimed.
    for (const id of MAIN_INTERCEPTED_COMMAND_IDS) {
      expect(resolveInterceptBindings({ [id]: [] }, true), id).not.toEqual(DEFAULTS)
    }
  })
})

/**
 * THE bug this suppression exists to close: the Settings shortcut recorder asks the user to PRESS
 * the chord they want to bind, and pressing ⌘W there used to reach `app:close-node` — deleting the
 * selected nodes instead of recording a keystroke. A claimed chord never reaches the page at all,
 * so the recorder's own `preventDefault`/`stopPropagation` cannot help: main has to stand down.
 */
describe('an armed shortcut recorder suspends every interception', () => {
  it('suppresses while armed and resumes on disarm', () => {
    let recording = true
    const seam = install(() => DEFAULTS, true, () => recording)
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    seam.fire({ meta: true, key: 'm', code: 'KeyM' })
    seam.fire({ meta: true, code: 'Digit0' })
    // Not swallowed either: `preventDefault` would take the key from the recorder as well as the
    // menu, so the suppression must return BEFORE it, not merely skip the send.
    expect(seam.prevented).toEqual([])
    expect(seam.sent).toEqual([])
    recording = false
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
    expect(seam.prevented).toEqual(['KeyW'])
  })

  it('is read per event, not captured at install time', () => {
    // The bit lives in a module-level `let` in index.ts that the renderer flips over IPC long
    // after the window was created; a captured boolean would make the whole feature inert.
    let recording = false
    const seam = install(() => DEFAULTS, true, () => recording)
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    recording = true
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
  })
})
