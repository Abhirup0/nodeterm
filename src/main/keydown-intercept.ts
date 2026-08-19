import { IPC } from '../shared/ipc'
import { getEffectiveBindings, sanitizeKeybindingOverrides } from '../shared/keybindings'
import { matchesShortcut } from '../shared/shortcut'

/**
 * The main window's `before-input-event` decision as ONE pure function — the desktop half of the
 * pair whose renderer half is `src/renderer/lib/zoomShortcut.ts` (same shape: a key-state-only
 * input, an action-or-null out, and the refusals as the point of the module).
 *
 * **Why the main process gets a say at all.** A menu accelerator is handled *before* the page sees
 * the key, so a renderer-side listener for one would simply never run on the desktop.
 * `before-input-event`'s `preventDefault` suppresses the menu item AND the page event, which is why
 * each claimed chord has to forward its intent to the renderer over IPC itself rather than letting
 * the key through. The three chords, and who claims them TODAY:
 *
 *   ⌘M → Window ▸ Minimize — a live accelerator on **every** platform (`{role:'minimize'}`).
 *   ⌘W → Window ▸ Close — a live accelerator on **Windows/Linux only**; the mac template has no
 *         `{role:'close'}`, so on macOS this module is now ⌘W's only handler.
 *   ⌘0 → not in any menu at all any more; this module is its only handler, which is exactly why
 *         the View menu's Fit View item deliberately carries NO accelerator.
 *
 * (This paragraph used to say "we never call `Menu.setApplicationMenu`, so Electron installs its
 * DEFAULT menu". That has been false since `buildAppMenu` landed in `index.ts`. The menu is OURS
 * now, so the list above is a fact about `buildAppMenu` — check it there, not against Electron's
 * defaults, and update this comment when you edit that template.)
 *
 * **Why it is pure and lives here rather than in the callback.** Deleting a branch from an inline
 * callback breaks nothing and throws nothing — the shortcut just quietly starts minimizing the
 * window / closing it / resetting the WINDOW's page zoom instead of doing the app's thing. Worse,
 * a modifier test here is what keeps a branch off ordinary typing, so loosening one silently makes
 * this window swallow **bare** keystrokes app-wide, and `index.ts` merges that kind of edit without
 * a conflict. Both failures are invisible to a test that reads the source; they are one assertion
 * each against this function.
 *
 * **This module stays the closed list of main-intercepted chords.** ⌘M and ⌘W are now resolved
 * from the keybinding registry (`node.toggleMarkdown` / `node.close`), so the USER decides which
 * chord they are — but nothing else is intercepted here, because everything else reaches the
 * renderer's dispatcher on its own. The **remappable** half of that list is ALSO written down in
 * `shared/keybindings.ts` as `MAIN_INTERCEPTED_COMMAND_IDS` (the Settings UI's app-wide shadow
 * warning reads it, and cannot derive it from here — main is not importable from the renderer);
 * a third REGISTRY-BACKED intercept added here owes that list an entry, which
 * `keydown-intercept.test.ts` pins. Note what that pin does NOT cover: a hardcoded ⌘0-shaped
 * intercept has no command id, so it cannot appear in the list and the invariant test cannot see
 * it — it would swallow its chord app-wide with the Settings recorder reporting no conflict. If
 * you add one, the Settings UI needs a separate way to know about it.
 *
 * Desktop-only by construction (it exists to fight a native menu), so it stays in `src/main` next
 * to `main-window.ts` rather than moving to `src/core` — the Server Edition's browser shell has no
 * application menu to steal a chord back from.
 */

/** What a claimed chord asks the renderer to do. */
export type KeydownInterceptAction = 'toggle-markdown' | 'close-node' | 'zoom-actual-size'

/** The subset of Electron's `Input` the decision is made from (so tests need no Electron). */
export interface KeydownInterceptInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  /** OS auto-repeat: true on every keyDown after the first while the chord is HELD. */
  isAutoRepeat: boolean
}

/**
 * A claimed chord. `preventDefault` is implied by getting one of these at all — the key is ours,
 * so neither the menu nor the page may have it. `action` is separately nullable because a HELD ⌘0
 * must keep being swallowed (the menu is still listening) while forwarding nothing.
 */
export interface KeydownInterceptDecision {
  action: KeydownInterceptAction | null
}

/** The effective chords for the two REMAPPABLE commands this module intercepts. `readonly
 *  string[]` in shortcut.ts's canonical spelling; `[]` means the user unbound the command, which
 *  must read as "do not claim the key" — Electron's own menu item comes back. */
export interface KeydownInterceptBindings {
  closeNode: readonly string[]
  toggleMarkdown: readonly string[]
}

/**
 * Effective M/W chords from raw settings overrides (sanitized here so a hand-edited settings.json
 * cannot crash or hijack the intercept — this runs on the way to `before-input-event`, the one
 * code path where a throw eats every keystroke in the window).
 */
export function resolveInterceptBindings(
  rawOverrides: unknown,
  isMac: boolean
): KeydownInterceptBindings {
  const { overrides } = sanitizeKeybindingOverrides(rawOverrides, isMac)
  return {
    closeNode: getEffectiveBindings('node.close', overrides, isMac),
    toggleMarkdown: getEffectiveBindings('node.toggleMarkdown', overrides, isMac)
  }
}

/** Electron's `Input` flags in the shape `matchesShortcut` reads. */
function toShortcutEvent(input: KeydownInterceptInput): {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
} {
  return {
    metaKey: input.meta,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    key: input.key
  }
}

/**
 * PURE. What this `before-input-event` input means, or `null` to leave the key completely alone
 * (no `preventDefault` — the page and, failing that, the menu get it).
 *
 * **Every branch owns its own modifier requirement, and must.** The old shared guard was
 * `type !== 'keyDown' || !(input.meta || input.control)`, which is exactly the check standing
 * between these branches and ordinary typing — `m`, `w` and `0` are all characters a user types.
 * It could not survive user-remappable bindings: an Alt-only chord is VALID per the registry's
 * rules, and this module is its ONLY dispatcher (a chord we claim never reaches the renderer),
 * so a primary-modifier gate above the matchers would make such a remap silently dead everywhere.
 * Who that actually buys something for: **Windows/Linux Alt chords** (`Alt+M`, `Alt+W` — plain
 * letter combos there), and on **macOS the Alt+non-letter ones** (`Alt+F5`, `Alt+ArrowUp`). It is
 * NOT mac Option+letter: macOS composes those into a character, so ⌥M arrives as `key: 'µ'` and an
 * `Alt+M` binding could never match there whatever this gate did.
 * So the two remappable chords are matched EXACTLY (all four modifier flags, `matchesShortcut`),
 * which is a modifier requirement per binding, and the hardcoded `Digit0` branch below carries
 * the `meta || control` test it used to inherit. `keydown-intercept.test.ts` presses each of them
 * bare; keep it that way.
 */
export function keydownIntercept(
  input: KeydownInterceptInput,
  bindings: KeydownInterceptBindings,
  isMac: boolean
): KeydownInterceptDecision | null {
  if (input.type !== 'keyDown') return null
  // Matched against the user's effective bindings (defaults ⌘M / ⌘W). `matchesShortcut` is exact
  // on meta/ctrl/alt/shift, so ⌘⇧M and ⌘⌥M — which the old `key === 'm'` branch also swallowed —
  // are now different chords and go back to the page. Parsing is memoized in shortcut.ts, so this
  // stays cheap on main's input path.
  const ev = toShortcutEvent(input)
  if (bindings.toggleMarkdown.some((s) => matchesShortcut(ev, s, isMac))) {
    return { action: 'toggle-markdown' }
  }
  // Repurpose Cmd/Ctrl+W: the renderer closes the selected node(s); if none are selected it asks
  // us to close the window (the standard behavior). ⇧ is left to the menu's Close All Windows —
  // now by the binding being `Cmd+W` and the match being exact, rather than by a `!input.shift`.
  if (bindings.closeNode.some((s) => matchesShortcut(ev, s, isMac))) {
    return { action: 'close-node' }
  }
  // NOT remappable: this is the renderer's `zoomShortcutChord` half of a canvas gesture, not a
  // registry command. Matched on the physical `code`, like that half: on a non-US layout the zero
  // key's `key` is not necessarily "0". Alt is excluded because AltGr reports as ctrl+alt and must
  // keep typing a real character; `meta || control` is the primary-modifier test it used to
  // inherit from the shared guard, and without it every bare `0` in the app is swallowed (#193).
  if (input.code === 'Digit0' && (input.meta || input.control) && !input.shift && !input.alt) {
    // Auto-repeat is dropped here rather than in the renderer, so a held chord cannot restart the
    // 200ms zoom tween — the same rule `zoomShortcutChord` applies to the keydown path. Still
    // claimed, so a held ⌘0 does not fall through to `resetZoom` on the second repeat.
    return { action: input.isAutoRepeat ? null : 'zoom-actual-size' }
  }
  return null
}

/**
 * PURE. Does this `did-start-navigation` mean the page that armed a shortcut recorder is going
 * away, so the recording bit must be cleared?
 *
 * **Why the bit needs a navigation leg at all.** The recording bit is GLOBAL and lives in the main
 * process, so every way the renderer can stop existing owes it a release. Window `closed` and
 * `render-process-gone` cover two of them. The third is a **reload** — and the app's own View menu
 * restores `{role:'reload'}` / `{role:'forceReload'}`, whose ⌘R/⌘⇧R are ACCELERATORS: they are
 * handled above the page, so the recorder's `preventDefault` cannot stop a user from pressing one
 * while armed. That reload fires no React unmount, no `closed` and no `render-process-gone`; the
 * new page mounts no recorder, and the bit would stay true forever — ⌘W/⌘M/⌘0 dead app-wide with
 * nothing left alive to clear them.
 *
 * The two filters are both refusals, and both matter:
 * - `isSameDocument` (Electron's newer name for the old `isInPlace`) is a `pushState`, a
 *   `replaceState` or a fragment jump — the SAME page, with the recorder still mounted and still
 *   armed. Clearing there would re-arm the intercepts under a live recorder, i.e. re-open the very
 *   bug this feature closes.
 * - A subframe navigating is not this page going away either.
 */
export function navigationClearsRecording(details: {
  isMainFrame: boolean
  isSameDocument: boolean
}): boolean {
  return details.isMainFrame && !details.isSameDocument
}

/** The renderer channel a claimed action is forwarded on. */
export function keydownInterceptChannel(action: KeydownInterceptAction): string {
  if (action === 'toggle-markdown') return IPC.appToggleMarkdown
  if (action === 'close-node') return IPC.appCloseNode
  return IPC.appZoomActualSize
}

/** Structural view of the window this installs on (keeps the module Electron-free, like
 *  `main-window.ts`). */
export interface KeydownInterceptTarget {
  webContents: {
    on(
      event: 'before-input-event',
      listener: (event: { preventDefault(): void }, input: KeydownInterceptInput) => void
    ): void
    send(channel: string, ...args: unknown[]): void
  }
}

/**
 * Wire `keydownIntercept` to `win`. The whole side-effecting half is these four lines, so a test
 * that calls this with a fake window exercises registration, the refusal, the `preventDefault` and
 * the forwarded channel together — everything except the single call site in `index.ts`.
 *
 * `getBindings` is read per event rather than captured: settings change while the window lives, and
 * it returns a cached object (`index.ts` recomputes it on `settingsStore.onChange`, not here — a
 * sanitize per keystroke would be real work on the input path).
 *
 * `isRecording` is the same shape and for the same reason — the renderer flips it over IPC while
 * this window is alive. **It is checked BEFORE `preventDefault`, not before the send**: a chord
 * THIS MODULE claims never reaches the page at all, so while the Settings shortcut recorder is
 * armed, leaving the key completely alone is the only way the recorder can see it. Swallowing but
 * not forwarding would still hand the recorder nothing — and forwarding is the live bug, since ⌘W
 * pressed into the recorder deletes the canvas's selected nodes.
 *
 * **What this stand-down does NOT buy, and cannot.** It only stops US from taking the key; it has
 * no say over the application MENU, whose accelerators are handled above the page either way. So
 * every menu accelerator is unrecordable while this stands down — including **⌘M**, which
 * `{role:'minimize'}` owns on every platform, and **Ctrl+W** on Windows/Linux, where the Window
 * submenu has a `{role:'close'}`. Pressing one of those into an armed recorder minimizes/closes the
 * window instead of recording. Concretely, the stand-down fully delivers **⌘0** everywhere and
 * **⌘W on macOS** (neither is in the menu), and cannot deliver ⌘M anywhere. Fixing that means
 * suspending the MENU while recording (`Menu.setApplicationMenu(null)` around the armed window, or
 * per-item `enabled:false`) — a change to `buildAppMenu`, not to this module. Known limitation;
 * see the PR body.
 */
export function installKeydownIntercepts(
  win: KeydownInterceptTarget,
  getBindings: () => KeydownInterceptBindings,
  isMac: boolean,
  isRecording: () => boolean
): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (isRecording()) return
    const decision = keydownIntercept(input, getBindings(), isMac)
    if (!decision) return
    event.preventDefault()
    if (decision.action) win.webContents.send(keydownInterceptChannel(decision.action))
  })
}
