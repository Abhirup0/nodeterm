/**
 * Pure keyboard-shortcut parse/match/format helpers, shared by the Canvas listener, the
 * Settings → Speech capture field, the Dock mic tooltip, and ShortcutsPanel.
 *
 * Canonical string shape: modifier tokens joined by "+", optionally ending in one non-modifier
 * key token, e.g. `"Cmd+Shift+D"`, `"Cmd+F5"`, or (v3) a MODIFIER-ONLY chord with no trailing key,
 * e.g. `"Cmd+Alt"`. `Cmd` is a PLATFORM-ABSTRACTED primary modifier — it means "the primary
 * modifier for this platform": metaKey (⌘) on mac, ctrlKey elsewhere. There is no separate literal
 * "Ctrl" token; storing shortcuts in terms of the abstract "Cmd" is what lets one stored string
 * match on every platform via `matchesShortcut(e, s, isMac)`.
 *
 * A modifier-only chord (`key === null`, see `isHoldChord`) means hold-to-talk: the chord is held
 * down to record and released to stop, instead of toggling on a keyed press. `chordHeld` (not
 * `matchesShortcut`, which requires a trailing key) is what the Canvas hold-mode listener uses to
 * test the held modifier state.
 */

export interface ParsedShortcut {
  /** Primary modifier required: metaKey on mac, ctrlKey elsewhere. */
  cmd: boolean
  shift: boolean
  alt: boolean
  /** Uppercased single char (e.g. "D") or named key (e.g. "F5", "SPACE", "ESCAPE"). `null` means
   *  a modifier-only (hold-to-talk) chord — see `isHoldChord`. */
  key: string | null
}

/** Friendly display labels for named (non single-char) keys. Falls back to title-case. */
const KEY_LABELS: Record<string, string> = {
  SPACE: 'Space',
  ENTER: 'Enter',
  RETURN: 'Enter',
  TAB: 'Tab',
  ESCAPE: 'Esc',
  ESC: 'Esc',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  ARROWUP: '↑',
  ARROWDOWN: '↓',
  ARROWLEFT: '←',
  ARROWRIGHT: '→'
}

/** Modifier-only `e.key` values — never a valid trailing key on their own. */
const MODIFIER_KEYS = new Set(['META', 'CONTROL', 'CTRL', 'SHIFT', 'ALT', 'ALTGRAPH', 'OS'])

/** `"d"` / `"D"` / `"Escape"` / `"F5"` -> the uppercased canonical key token. */
function normalizeKey(key: string): string {
  return key.toUpperCase()
}

/** True when `key` (a raw `e.key`, any case) names a modifier key itself rather than a
 *  printable/named key — e.g. `"Meta"`, `"Alt"`, `"Shift"`. Exported so the Settings capture
 *  field and the Canvas hold-mode listener can classify a keydown/keyup the same way
 *  `captureToShortcut` does internally. */
export function isModifierEventKey(key: string): boolean {
  return MODIFIER_KEYS.has(normalizeKey(key))
}

/** Parse a canonical combo string, e.g. `"Cmd+Shift+D"` -> `{cmd:true, shift:true, alt:false,
 *  key:'D'}`; a modifier-only chord, e.g. `"Cmd+Alt"` -> `{cmd:true, shift:false, alt:true,
 *  key:null}` (see `isHoldChord`). */
export function parseShortcut(s: string): ParsedShortcut {
  const parts = s
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)

  let cmd = false
  let shift = false
  let alt = false
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'cmd' || lower === 'command' || lower === 'ctrl' || lower === 'control') {
      cmd = true
    } else if (lower === 'shift') {
      shift = true
    } else if (lower === 'alt' || lower === 'option') {
      alt = true
    } else {
      key = normalizeKey(part)
    }
  }
  return { cmd, shift, alt, key }
}

/** True when `s` is a modifier-only chord (no trailing key) — the v3 hold-to-talk shape. A
 *  keyed combo (`"Cmd+Alt+D"`) keeps the existing press-to-talk toggle behavior; the mode is
 *  derived from the stored string, not a separate setting. */
export function isHoldChord(s: string): boolean {
  return parseShortcut(s).key === null
}

/** `"D"` -> `"D"`, `"SPACE"` -> `"Space"`, `"F5"` -> `"F5"`, unknown multi-char -> title case. */
function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  if (key.length <= 1) return key
  if (/^F\d{1,2}$/.test(key)) return key
  return key.charAt(0) + key.slice(1).toLowerCase()
}

/** `"Cmd+Shift+D"` + mac -> `["⌘", "⇧", "D"]`; + non-mac -> `["Ctrl", "Shift", "D"]`; a
 *  modifier-only chord (`"Cmd+Alt"`) -> `["⌘", "⌥"]` (no trailing key badge). One badge per
 *  element — used by ShortcutsPanel's `<kbd>` row rendering. */
export function shortcutKeyParts(s: string, isMac: boolean): string[] {
  const { cmd, shift, alt, key } = parseShortcut(s)
  const parts: string[] = []
  if (isMac) {
    if (cmd) parts.push('⌘')
    if (alt) parts.push('⌥')
    if (shift) parts.push('⇧')
  } else {
    if (cmd) parts.push('Ctrl')
    if (alt) parts.push('Alt')
    if (shift) parts.push('Shift')
  }
  if (key !== null) parts.push(keyLabel(key))
  return parts
}

/** `"Cmd+Shift+D"` + mac -> `"⌘⇧D"`; + non-mac -> `"Ctrl+Shift+D"`; a modifier-only chord
 *  (`"Cmd+Alt"`) -> `"⌘⌥"` / `"Ctrl+Alt"`. */
export function formatShortcut(s: string, isMac: boolean): string {
  const parts = shortcutKeyParts(s, isMac)
  return isMac ? parts.join('') : parts.join('+')
}

/** Minimal shape of a KeyboardEvent this module needs — kept structural so callers don't have
 *  to import `KeyboardEvent` (and so it's trivially fakeable in tests). */
export interface ShortcutKeyEvent {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
}

/** Does `e` match the canonical combo `s`? `cmd` in `s` means metaKey on mac, ctrlKey elsewhere.
 *  For a keyed combo only — a modifier-only chord (`isHoldChord(s)`) never matches here (its
 *  `key` is `null`, which no `e.key` ever equals); the Canvas hold-mode listener uses
 *  `chordHeld` instead. */
export function matchesShortcut(e: ShortcutKeyEvent, s: string, isMac: boolean): boolean {
  const parsed = parseShortcut(s)
  const primaryPressed = isMac ? e.metaKey : e.ctrlKey
  if (parsed.cmd !== primaryPressed) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false
  return parsed.key !== null && normalizeKey(e.key) === parsed.key
}

/** True when `e`'s currently-held modifiers EXACTLY cover `s`'s modifiers (no key check, and no
 *  extra modifier beyond what `s` requires). Used by the Canvas hold-mode listener for a
 *  modifier-only chord: "is the chord fully down" (arm, on keydown) and "did one of the chord's
 *  own modifiers just come up" (release, on keyup — the keyup event's own modifier flags already
 *  reflect the key that was just released). An extra modifier held on top of the chord (e.g.
 *  Shift added to a `Cmd+Alt` chord) makes this false, which is also the "third key" misfire
 *  guard for modifier keys specifically (a non-modifier third key is guarded separately, since
 *  this function ignores `e.key` entirely). */
export function chordHeld(e: ShortcutKeyEvent, s: string, isMac: boolean): boolean {
  const parsed = parseShortcut(s)
  const primaryPressed = isMac ? e.metaKey : e.ctrlKey
  return parsed.cmd === primaryPressed && parsed.shift === e.shiftKey && parsed.alt === e.altKey
}

/**
 * Build a canonical combo string from a captured keydown, for the Settings capture field.
 * Requires the platform's primary modifier (Cmd on mac / Ctrl elsewhere) plus a non-modifier
 * key; returns null while only modifier keys have been pressed so far, or when the primary
 * modifier is missing. (A modifier-only chord is captured separately — see `buildModifierChord`
 * below — because it commits on keyUP once every key is released, by which point the keyup
 * event's own modifier flags are already false and can't be read off it directly.)
 */
export function captureToShortcut(e: ShortcutKeyEvent, isMac: boolean): string | null {
  const primaryPressed = isMac ? e.metaKey : e.ctrlKey
  if (!primaryPressed) return null
  const key = normalizeKey(e.key)
  if (MODIFIER_KEYS.has(key)) return null
  const parts = ['Cmd']
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** The modifier state observed while capturing a would-be hold-to-talk chord (see
 *  `buildModifierChord`). */
export interface ChordModifiers {
  cmd: boolean
  alt: boolean
  shift: boolean
}

/** `{cmd:true, alt:true, shift:false}` -> `"Cmd+Alt"`; `{cmd:false, ...}` -> `null` (the primary
 *  modifier is mandatory, same as `captureToShortcut`). The Settings capture field calls this at
 *  keyUp, once every key has been released, using the modifier state it remembered from the last
 *  keyDown while only modifier keys had been pressed (`isModifierEventKey`) — the keyup event
 *  itself no longer carries that state. */
export function buildModifierChord(mods: ChordModifiers): string | null {
  if (!mods.cmd) return null
  const parts = ['Cmd']
  if (mods.alt) parts.push('Alt')
  if (mods.shift) parts.push('Shift')
  return parts.join('+')
}
