import { IPC } from '../shared/ipc'

/**
 * The main window's `before-input-event` decision as ONE pure function — the desktop half of the
 * pair whose renderer half is `src/renderer/lib/zoomShortcut.ts` (same shape: a key-state-only
 * input, an action-or-null out, and the refusals as the point of the module).
 *
 * **Why the main process gets a say at all.** We never call `Menu.setApplicationMenu`, so Electron
 * installs its DEFAULT application menu, and that menu already claims all three of these chords:
 *
 *   ⌘M → Window ▸ Minimize     ⌘W → Window ▸ Close     ⌘0 → View ▸ Actual Size (`resetZoom`)
 *
 * A menu accelerator is handled *before* the page sees the key, so a renderer-side listener for any
 * of them would simply never run on the desktop. `before-input-event`'s `preventDefault` suppresses
 * the menu item AND the page event, which is why each claimed chord has to forward its intent to
 * the renderer over IPC itself rather than letting the key through.
 *
 * **Why it is pure and lives here rather than in the callback.** Deleting a branch from an inline
 * callback breaks nothing and throws nothing — the shortcut just quietly starts minimizing the
 * window / closing it / resetting the WINDOW's page zoom instead of doing the app's thing. Worse,
 * the guard below is *shared* by three branches, so a change to it silently re-decides chords it
 * was not aimed at: loosen it and this window starts swallowing **bare** keystrokes app-wide, and
 * `index.ts` merges that kind of edit without a conflict. Both failures are invisible to a test
 * that reads the source; they are one assertion each against this function.
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

/**
 * PURE. What this `before-input-event` input means, or `null` to leave the key completely alone
 * (no `preventDefault` — the page and, failing that, the menu get it).
 *
 * The primary-modifier requirement is deliberately in the shared guard *and* is the only thing
 * standing between the branches below and ordinary typing: `m`, `w` and `0` are all characters a
 * user types. Any rewrite that moves the modifier decision into the individual branches has to
 * give **every** branch one — see `keydown-intercept.test.ts`, which presses each of them bare.
 */
export function keydownIntercept(input: KeydownInterceptInput): KeydownInterceptDecision | null {
  if (input.type !== 'keyDown' || !(input.meta || input.control)) return null
  const key = input.key.toLowerCase()
  if (key === 'm') return { action: 'toggle-markdown' }
  // Repurpose Cmd/Ctrl+W: the renderer closes the selected node(s); if none are selected it asks
  // us to close the window (the standard behavior). ⇧ is left to the menu's Close All Windows.
  if (key === 'w' && !input.shift) return { action: 'close-node' }
  // Matched on the physical `code`, like the renderer's half of the chord (`zoomShortcutChord`):
  // on a non-US layout the zero key's `key` is not necessarily "0". Alt is excluded because AltGr
  // reports as ctrl+alt and must keep typing a real character.
  if (input.code === 'Digit0' && !input.shift && !input.alt) {
    // Auto-repeat is dropped here rather than in the renderer, so a held chord cannot restart the
    // 200ms zoom tween — the same rule `zoomShortcutChord` applies to the keydown path. Still
    // claimed, so a held ⌘0 does not fall through to `resetZoom` on the second repeat.
    return { action: input.isAutoRepeat ? null : 'zoom-actual-size' }
  }
  return null
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
 */
export function installKeydownIntercepts(win: KeydownInterceptTarget): void {
  win.webContents.on('before-input-event', (event, input) => {
    const decision = keydownIntercept(input)
    if (!decision) return
    event.preventDefault()
    if (decision.action) win.webContents.send(keydownInterceptChannel(decision.action))
  })
}
