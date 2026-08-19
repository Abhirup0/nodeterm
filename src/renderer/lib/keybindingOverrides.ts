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
