// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XTERM_INPUT_CLASS } from './keyContext'
import { TERMINAL_FOCUS_RECHECK_MS, installTerminalFocusMirror } from './terminalFocusMirror'

/**
 * REAL DOM (jsdom), because every question this module answers is a question about focus event
 * ORDER and about what `document.activeElement` says at each point — and a hand-rolled fake would
 * simply encode whatever the author assumed. The three facts below were MEASURED against jsdom
 * before this module was written, and each one decides a line of it:
 *
 *   1. `focusout` fires with `document.activeElement` already reset to `<body>` — the incoming
 *      element is not focused yet. So an immediate read during focusout answers "no terminal" for
 *      EVERY focus move, including terminal → terminal.
 *   2. A microtask scheduled from that same `focusout` reads the SETTLED element. So deferring the
 *      read collapses a terminal → terminal hop into no change at all.
 *   3. Removing the focused element from the document fires NO focusout whatsoever; activeElement
 *      silently becomes `<body>`. That is the stuck-state path this app actually walks — a parked,
 *      released or deleted terminal node tears its xterm out of the DOM — and it is why the
 *      mirror carries a re-check that does not depend on an event arriving.
 */

const report = vi.fn<(focused: boolean) => void>()
let stop: (() => void) | null = null

function terminalTextarea(): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  ta.className = XTERM_INPUT_CLASS
  document.body.append(ta)
  return ta
}

function ordinaryInput(): HTMLInputElement {
  const el = document.createElement('input')
  document.body.append(el)
  return el
}

/** Let the mirror's deferred read run. */
const settle = (): Promise<void> => Promise.resolve()

beforeEach(() => {
  vi.useFakeTimers()
  report.mockClear()
  document.body.innerHTML = ''
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
})

describe('installTerminalFocusMirror', () => {
  it('reports true when an xterm textarea takes focus, and false when it loses it', async () => {
    const term = terminalTextarea()
    const input = ordinaryInput()
    stop = installTerminalFocusMirror({ report })
    expect(report).toHaveBeenCalledWith(false) // the initial read: nothing focused yet

    report.mockClear()
    term.focus()
    await settle()
    expect(report.mock.calls).toEqual([[true]])

    report.mockClear()
    input.focus()
    await settle()
    expect(report.mock.calls).toEqual([[false]])
  })

  it('is change-deduped: focus moving between two terminals reports nothing at all', async () => {
    const a = terminalTextarea()
    const b = terminalTextarea()
    stop = installTerminalFocusMirror({ report })
    a.focus()
    await settle()
    report.mockClear()

    // The measured trap: `focusout` fires with activeElement === <body>, so an IMMEDIATE read here
    // would report false-then-true on every hop between terminals — a window, however brief, in
    // which main re-arms the intercepts under a terminal that never lost focus. Two chords land in
    // that window in practice (⌘W closing a node mid-edit is the one users would file).
    b.focus()
    await settle()
    expect(report).not.toHaveBeenCalled()
  })

  it('reports the CURRENT state once at install, before any event fires', async () => {
    terminalTextarea().focus()
    stop = installTerminalFocusMirror({ report })
    // Focus predates the mirror (the canvas mounts after a reload with a terminal already focused).
    // Without this initial read main would sit on its `false` until the user clicked away and back.
    expect(report.mock.calls).toEqual([[true]])
  })

  it('reports false when the window loses focus, and re-reports on regain', async () => {
    const term = terminalTextarea()
    stop = installTerminalFocusMirror({ report })
    term.focus()
    await settle()
    report.mockClear()

    // A window blur leaves `document.activeElement` on the terminal, so the ordinary read would
    // keep saying true. The fail-safe direction is "not focused" — main's intercepts belong to the
    // window that has the keyboard.
    window.dispatchEvent(new Event('blur'))
    expect(report.mock.calls).toEqual([[false]])

    // ...and coming back must re-engage. Without this leg the mirror would be stuck FALSE for a
    // terminal that still holds focus — the intercepts would keep claiming ⌘W under a user who
    // asked their terminal to have it, with no event left to correct it.
    report.mockClear()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(report.mock.calls).toEqual([[true]])
  })

  it('the re-check does not undo a window blur', async () => {
    const term = terminalTextarea()
    stop = installTerminalFocusMirror({ report })
    term.focus()
    await settle()
    window.dispatchEvent(new Event('blur'))
    report.mockClear()

    // `document.activeElement` is STILL the terminal while the window sits in the background, so a
    // re-check that only asked the DOM would report `true` again two seconds later and make the
    // blur leg decoration. Whether this window has the keyboard is a separate fact and is tracked
    // as one.
    vi.advanceTimersByTime(TERMINAL_FOCUS_RECHECK_MS * 3)
    expect(report).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(report.mock.calls).toEqual([[true]])
  })

  it('recovers when the focused terminal is removed from the DOM without any focus event', async () => {
    const term = terminalTextarea()
    stop = installTerminalFocusMirror({ report })
    term.focus()
    await settle()
    report.mockClear()

    // Park / offscreen release / node delete all rip the xterm out from under a focus that may
    // still be on it. jsdom fires NOTHING here (measured), and the browsers disagree about whether
    // they fire `blur` — so the mirror may not lean on an event. Left uncorrected this is the worst
    // failure this feature has: main believes a terminal is focused forever, stands its intercepts
    // down forever, and ⌘W/⌘M go to the application MENU — closing and minimizing the window.
    term.remove()
    expect(report).not.toHaveBeenCalled() // nothing observed it yet — that is the whole problem

    vi.advanceTimersByTime(TERMINAL_FOCUS_RECHECK_MS)
    expect(report.mock.calls).toEqual([[false]])
  })

  it('the re-check is silent while nothing changed', async () => {
    terminalTextarea().focus()
    stop = installTerminalFocusMirror({ report })
    await settle()
    report.mockClear()
    vi.advanceTimersByTime(TERMINAL_FOCUS_RECHECK_MS * 5)
    // Change-deduped, so the safety net costs zero IPC in the steady state — which is what makes
    // a timer an acceptable price for closing the case above.
    expect(report).not.toHaveBeenCalled()
  })

  it('releases the bit on teardown, then stops completely — no listeners, no timer', async () => {
    const term = terminalTextarea()
    term.focus()
    stop = installTerminalFocusMirror({ report })
    await settle()
    report.mockClear()

    // Teardown reports `false` on its way out rather than leaving main holding a `true` nobody
    // owns any more. Main's three page-death resets cover the page VANISHING; this covers the
    // ordinary case where the page lives and only this mirror stops. A remount re-reports from
    // scratch (`last` starts null), so nothing is lost by releasing here.
    stop()
    stop = null
    expect(report.mock.calls).toEqual([[false]])
    report.mockClear()

    term.focus()
    await settle()
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(TERMINAL_FOCUS_RECHECK_MS * 3)
    // A leaked listener on a remounted canvas would double-report, and a leaked interval would
    // keep a torn-down page's answer flowing to main after the mirror was supposed to be gone.
    expect(report).not.toHaveBeenCalled()
  })
})
