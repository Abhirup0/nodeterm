/**
 * Mirror "an xterm currently has keyboard focus" from the renderer to the main process, so the
 * window's `before-input-event` intercepts can stand down under the `terminal-first` shortcut
 * policy (`src/main/keydown-intercept.ts`).
 *
 * **Why main cannot answer this itself.** `before-input-event` fires BEFORE the page sees the key,
 * so by the time any renderer handler could look at `document.activeElement` main has already
 * decided whether to `preventDefault`. The answer has to be standing there in advance, which makes
 * it a mirror — a fact main holds a possibly-stale copy of — and every design choice below is
 * about that staleness.
 *
 * **Fail-safe direction: NOT focused.** A missing, stale or never-sent mirror must read as "no
 * terminal is focused", i.e. the intercepts stay ON and the app behaves exactly as it did before
 * this feature. The opposite direction is the expensive one: main would stand down forever, ⌘W and
 * ⌘M would go to the application MENU (close window / minimize), and no live component would be
 * left to correct it. Main enforces its half (a `false` initial value plus a reset on every way
 * the page can stop existing); this module enforces the renderer's half by never leaving a `true`
 * standing on an event that may not arrive.
 *
 * Extracted from `Canvas.tsx` rather than written inline as an effect **because the interesting
 * cases are the ones no manual test walks**: focus hopping between two terminals, a window blur,
 * and a focused terminal being torn out of the DOM by a park / offscreen release / node delete.
 * `terminalFocusMirror.test.ts` presses all three against a real (jsdom) DOM.
 */
import { isTerminalTarget, type ContextElement } from './keyContext'

/**
 * How often the mirror re-reads focus with no event to prompt it. This exists for ONE measured
 * case: removing the focused element from the document fires **no** focus event at all (jsdom
 * fires nothing; browsers disagree about whether they fire `blur`), and this app removes focused
 * xterm textareas routinely — terminal park, the offscreen release, and node deletion all do it.
 * Without a re-check that case leaves the mirror stuck on `true` permanently.
 *
 * The read is `document.activeElement` plus one `classList.contains`, and the report is
 * change-deduped, so the steady-state cost of this net is a property read per interval and zero
 * IPC. 2s is picked so a stuck `true` self-heals well inside the time it takes a user to notice a
 * terminal vanished and reach for a chord.
 */
export const TERMINAL_FOCUS_RECHECK_MS = 2000

export interface TerminalFocusMirrorOptions {
  /** Where the answer goes. Called ONLY when the answer changed — main holds a boolean, so
   *  re-sending the same value is pure IPC noise on a canvas that changes focus constantly. */
  report: (focused: boolean) => void
  /** Overridable purely for tests; see the deferred read in `schedule` below. */
  recheckMs?: number
}

/**
 * Start mirroring. Returns the teardown — it removes every listener AND clears the re-check timer;
 * a leaked one of either would keep reporting from a canvas that has been replaced.
 */
export function installTerminalFocusMirror(opts: TerminalFocusMirrorOptions): () => void {
  const { report, recheckMs = TERMINAL_FOCUS_RECHECK_MS } = opts
  let last: boolean | null = null
  let stopped = false
  /**
   * Does this WINDOW have the keyboard? Tracked as its own flag because `document.activeElement`
   * does not answer it — an element keeps being the active element while the whole window sits in
   * the background, so without this the re-check below would quietly re-report `true` two seconds
   * after the blur leg pushed `false`, and the blur leg would be decoration.
   *
   * Seeded `true` rather than from `document.hasFocus()`: that answers differently across
   * environments (jsdom says `false` for a perfectly ordinary document — measured), and of the two
   * ways to be wrong at mount only one is expensive. A wrong `true` costs nothing — an unfocused
   * window receives no `before-input-event` at all, and the `focus` leg re-reads the moment it does
   * — whereas a wrong `false` would leave the policy silently dead over a terminal that is focused
   * and fires no further focus event.
   */
  let windowFocused = true

  const focusedNow = (): boolean =>
    windowFocused && isTerminalTarget(document.activeElement as unknown as ContextElement | null)

  /** Report `focused` if it differs from what main was last told. */
  const push = (focused: boolean): void => {
    if (stopped || focused === last) return
    last = focused
    report(focused)
  }

  /**
   * Read `document.activeElement` **in a microtask**, not inline.
   *
   * MEASURED (jsdom, and the same order the HTML spec prescribes): `focusout` is dispatched with
   * `activeElement` already reset to `<body>` — the incoming element is not focused yet — and the
   * matching `focusin` follows afterwards. An inline read therefore answers "no terminal" for
   * every single focus move, including terminal → terminal, so main would re-arm its intercepts
   * for the gap between the two events. A microtask scheduled from `focusout` reads the SETTLED
   * element (measured), which collapses a terminal → terminal hop into no report at all and still
   * answers `<body>` when focus genuinely went nowhere.
   */
  const readSoon = (): void => {
    queueMicrotask(() => push(focusedNow()))
  }

  const onFocusIn = (): void => readSoon()
  const onFocusOut = (): void => readSoon()
  /** The window lost the keyboard. `document.activeElement` stays on the terminal, so the answer
   *  has to come from `windowFocused` — and it must be recorded there, not just pushed, or the
   *  re-check would undo it on its next tick. */
  const onWindowBlur = (): void => {
    windowFocused = false
    push(focusedNow())
  }
  /** ...and the matching re-engage. Regaining window focus does not reliably fire `focusin` on the
   *  element that still holds focus, so without this leg the mirror would sit stuck at `false`
   *  over a focused terminal — the safe direction, but a policy that silently stopped working. */
  const onWindowFocus = (): void => {
    windowFocused = true
    readSoon()
  }

  window.addEventListener('focusin', onFocusIn)
  window.addEventListener('focusout', onFocusOut)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  const timer = setInterval(() => push(focusedNow()), recheckMs)

  // The state BEFORE any event: the canvas mounts after a reload with focus already somewhere, and
  // main is sitting on its `false` until told otherwise. Synchronous on purpose — this is the one
  // read with no focus transition to settle.
  push(focusedNow())

  return () => {
    // Release the bit on the way out rather than leaving main holding a `true` that nobody owns
    // any more. Main's resets cover the page VANISHING; this covers the ordinary case where the
    // page lives and only this mirror stops. Before `stopped`, or `push` would refuse it. A
    // remount re-reports from scratch (`last` starts null), so nothing is lost.
    push(false)
    stopped = true
    window.removeEventListener('focusin', onFocusIn)
    window.removeEventListener('focusout', onFocusOut)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('focus', onWindowFocus)
    clearInterval(timer)
  }
}
