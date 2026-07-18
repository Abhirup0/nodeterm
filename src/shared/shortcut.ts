/**
 * Pure keyboard-shortcut parse/match/format helpers, shared by the Canvas listener, the
 * Settings → Speech capture field, the Dock mic tooltip, and ShortcutsPanel.
 *
 * Canonical string shape: modifier tokens joined by "+", ending in one non-modifier key token,
 * e.g. `"Cmd+Shift+D"`, `"Cmd+F5"`. `Cmd` is a PLATFORM-ABSTRACTED primary modifier — it means
 * "the primary modifier for this platform": metaKey (⌘) on mac, ctrlKey elsewhere. There is no
 * separate literal "Ctrl" token; storing shortcuts in terms of the abstract "Cmd" is what lets
 * one stored string match on every platform via `matchesShortcut(e, s, isMac)`.
 */

export interface ParsedShortcut {
  /** Primary modifier required: metaKey on mac, ctrlKey elsewhere. */
  cmd: boolean
  shift: boolean
  alt: boolean
  /** Uppercased single char (e.g. "D") or named key (e.g. "F5", "SPACE", "ESCAPE"). */
  key: string
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

/** Parse a canonical combo string, e.g. `"Cmd+Shift+D"` -> `{cmd:true, shift:true, alt:false, key:'D'}`. */
export function parseShortcut(s: string): ParsedShortcut {
  const parts = s
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)

  let cmd = false
  let shift = false
  let alt = false
  let key = ''
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

/** `"D"` -> `"D"`, `"SPACE"` -> `"Space"`, `"F5"` -> `"F5"`, unknown multi-char -> title case. */
function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  if (key.length <= 1) return key
  if (/^F\d{1,2}$/.test(key)) return key
  return key.charAt(0) + key.slice(1).toLowerCase()
}

/** `"Cmd+Shift+D"` + mac -> `["⌘", "⇧", "D"]`; + non-mac -> `["Ctrl", "Shift", "D"]`. One badge
 *  per element — used by ShortcutsPanel's `<kbd>` row rendering. */
export function shortcutKeyParts(s: string, isMac: boolean): string[] {
  const { cmd, shift, alt, key } = parseShortcut(s)
  const label = keyLabel(key)
  if (isMac) {
    const parts: string[] = []
    if (cmd) parts.push('⌘')
    if (alt) parts.push('⌥')
    if (shift) parts.push('⇧')
    parts.push(label)
    return parts
  }
  const parts: string[] = []
  if (cmd) parts.push('Ctrl')
  if (alt) parts.push('Alt')
  if (shift) parts.push('Shift')
  parts.push(label)
  return parts
}

/** `"Cmd+Shift+D"` + mac -> `"⌘⇧D"`; + non-mac -> `"Ctrl+Shift+D"`. */
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

/** Does `e` match the canonical combo `s`? `cmd` in `s` means metaKey on mac, ctrlKey elsewhere. */
export function matchesShortcut(e: ShortcutKeyEvent, s: string, isMac: boolean): boolean {
  const parsed = parseShortcut(s)
  const primaryPressed = isMac ? e.metaKey : e.ctrlKey
  if (parsed.cmd !== primaryPressed) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false
  return normalizeKey(e.key) === parsed.key
}

/**
 * Build a canonical combo string from a captured keydown, for the Settings capture field.
 * Requires the platform's primary modifier (Cmd on mac / Ctrl elsewhere) plus a non-modifier
 * key; returns null while only modifier keys have been pressed so far, or when the primary
 * modifier is missing.
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
