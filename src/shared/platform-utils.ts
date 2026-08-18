/**
 * Platform detection + display helpers for keyboard-shortcut labels.
 *
 * Display only: key HANDLERS across the renderer already accept `metaKey || ctrlKey`
 * (Server Edition heritage) — these helpers fix what the user *sees*. Navigator-based
 * (not process.platform) so the answer is correct in the Electron renderer AND in a
 * Server Edition browser tab on any OS. Canonical shortcut strings stay mac-notation
 * (`⌘⇧Z`) at their definition sites; the rewrite happens at render time.
 */

/** True on macOS (Electron renderer or browser). Safe outside a DOM (falls back to mac notation). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true
  return /Mac/i.test(navigator.platform || navigator.userAgent)
}

/** True on Windows (Electron renderer or browser — same `navigator`-based detection as
 *  `isMacPlatform`, so it is correct in both the desktop app and a Server Edition browser tab). */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Win/i.test(navigator.platform || navigator.userAgent)
}

/** Rewrite mac chord notation in a hint string for the current platform. */
export function hintLabel(text: string, isMac: boolean = isMacPlatform()): string {
  if (isMac) return text
  return text
    .replace(/⌘⇧/g, 'Ctrl+Shift+')
    .replace(/⌘(?=[A-Za-z0-9,/↵])/g, 'Ctrl+')
    .replace(/⌘/g, 'Ctrl')
    .replace(/⇧/g, 'Shift+')
}

/** Map a single key token (as used by ShortcutsPanel's keys arrays). */
export function keyLabel(key: string, isMac: boolean = isMacPlatform()): string {
  if (isMac) return key
  if (key === '⌘') return 'Ctrl'
  if (key === '⇧') return 'Shift'
  return key
}

/** The platform's primary modifier symbol. */
export function modSymbol(isMac: boolean = isMacPlatform()): string {
  return keyLabel('⌘', isMac)
}
