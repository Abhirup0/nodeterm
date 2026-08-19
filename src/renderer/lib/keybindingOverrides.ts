/**
 * The renderer's single read path for shortcut overrides: sanitize once per settings change
 * (memoized by the raw object's reference — `useSettings.update` replaces the settings object
 * but keeps untouched sub-objects), warn once, and serve effective bindings + display strings
 * from it. Everything that shows or matches a registry chord goes through here so dispatch,
 * ShortcutsPanel, and tooltips cannot disagree.
 */
import {
  getEffectiveBindings, sanitizeKeybindingOverrides,
  type CommandId, type KeybindingOverrides
} from '@shared/keybindings'
import { shortcutKeyParts } from '@shared/shortcut'
import { isMacPlatform } from '@shared/platform-utils'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'

const UNSET = Symbol('unset')
let lastRaw: unknown = UNSET
let lastSanitized: KeybindingOverrides = {}

export function activeKeybindingOverrides(): KeybindingOverrides {
  const raw = useSettings.getState().settings.keybindings
  if (raw === lastRaw) return lastSanitized
  const { overrides, warnings } = sanitizeKeybindingOverrides(raw, isMacPlatform())
  if (warnings.length) console.warn(`[keybindings] ${warnings.join(' ')}`)
  lastRaw = raw
  lastSanitized = overrides
  return overrides
}

export function effectiveBindings(id: CommandId): readonly string[] {
  return getEffectiveBindings(id, activeKeybindingOverrides(), isMacPlatform())
}

/** Display parts of the command's first effective binding; [] when unbound. */
export function commandKeys(id: CommandId, isMac: boolean = isMacPlatform()): string[] {
  const first = getEffectiveBindings(id, activeKeybindingOverrides(), isMac)[0]
  return first ? shortcutKeyParts(first, isMac) : []
}

/** `('Sessions', 'panel.sessions')` -> `'Sessions (⌘⇧L)'` (mac) / `'Sessions (Ctrl+Shift+L)'`
 *  — the same strings hintLabel produced for the defaults, but following remaps; bare text
 *  when unbound. */
export function commandTooltip(text: string, id: CommandId, isMac: boolean = isMacPlatform()): string {
  const parts = commandKeys(id, isMac)
  if (!parts.length) return text
  return `${text} (${isMac ? parts.join('') : parts.join('+')})`
}

/** The bare chord, as a chip: `'⌘K'` (mac) / `'Ctrl+K'`. **`''` when unbound** — every caller
 *  embeds this in a sentence (`⌘M to exit`, `Message (⌘Enter to commit)`), so they must test it
 *  and fall back to chord-less copy rather than rendering a stray fragment. */
export function chipFor(id: CommandId, isMac: boolean = isMacPlatform()): string {
  const parts = commandKeys(id, isMac)
  return isMac ? parts.join('') : parts.join('+')
}

/** The single WRITE path for overrides. `null` = reset (delete the key, defaults return);
 *  `[]` = disabled. Values are stored as given — callers pass canonical strings from
 *  `normalizeBindingForCommand`; the read path's sanitizer remains the safety net for
 *  hand-edited files. `speech.dictation` also mirrors its first binding into the legacy
 *  `speech.shortcut` field for one release, so a downgraded build keeps the user's chord.
 *  On DISABLE (`[]`) `bindings?.[0]` is `undefined`, so the mirror falls back to the DEFAULT
 *  chord rather than an empty string: a downgraded build then gets default dictation instead
 *  of a broken value it cannot parse.
 *
 *  **Raw in, sanitized out — the two maps are not the same map.** This writes into the RAW
 *  `settings.keybindings` object, while every UI gate (the chips, Disable/Reset visibility,
 *  `commitCandidate`'s conflict check) reads the SANITIZED one. So a hand-edited entry the
 *  sanitizer drops — an unknown id, an invalid chord, a conflict participant — is invisible to
 *  the gate yet still sitting on disk, and it stays there until a UI write for that command, or
 *  a Reset, replaces the map. */
export function setKeybindingOverride(id: CommandId, bindings: readonly string[] | null): void {
  const state = useSettings.getState()
  const next: KeybindingOverrides = { ...(state.settings.keybindings ?? {}) }
  if (bindings === null) delete next[id]
  else next[id] = [...bindings]
  if (id === 'speech.dictation') {
    const mirror = bindings?.[0] ?? DEFAULT_SETTINGS.speech.shortcut
    state.update({
      keybindings: next,
      speech: { ...state.settings.speech, shortcut: mirror }
    })
    return
  }
  state.update({ keybindings: next })
}

/** Display parts for EVERY effective binding (the panel shows the first; the Settings section
 *  shows them all). [] when unbound/disabled. */
export function commandKeysFor(id: CommandId, isMac: boolean = isMacPlatform()): string[][] {
  return getEffectiveBindings(id, activeKeybindingOverrides(), isMac).map((b) =>
    shortcutKeyParts(b, isMac)
  )
}

/** The dictation chord's single source: the first effective `speech.dictation` binding.
 *  `''` = the user disabled it (dictation shortcut off; the mic button still works). */
export function dictationBinding(): string {
  return effectiveBindings('speech.dictation')[0] ?? ''
}
