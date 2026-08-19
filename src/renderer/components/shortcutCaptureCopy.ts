/**
 * What the capture notice SAYS, kept pure so it can be tested without a DOM and so the banner
 * stays a subscription plus markup.
 *
 * Two things this returns `null` for, and they mean the same thing to the caller — **show
 * nothing**:
 *   - an id the registry does not know. The id arrives inside a `CustomEvent.detail` off
 *     `window`, so its `CommandId` type is a compile-time claim, not a runtime fact.
 *   - a command with no effective chord (unbound, or the user disabled it). The whole sentence is
 *     built around the chord that took the key; with none to quote the notice could only assert
 *     that *something* was captured, which is worse than silence.
 *
 * The chord is read through `chipFor`, so the notice quotes the binding IN FORCE — a remapped
 * command names the user's own chord, never the registry default they no longer use.
 */
import { COMMANDS_BY_ID, type CommandId } from '@shared/keybindings'
import { isMacPlatform } from '@shared/platform-utils'
import { chipFor } from '../lib/keybindingOverrides'

export interface ShortcutCaptureCopy {
  title: string
  body: string
}

export function shortcutCaptureCopy(
  id: CommandId,
  isMac: boolean = isMacPlatform()
): ShortcutCaptureCopy | null {
  const def = COMMANDS_BY_ID.get(id)
  if (!def) return null
  const chip = chipFor(id, isMac)
  if (!chip) return null
  return {
    title: def.title,
    // Names both exits the user has — remap this one chord, or hand every chord to the terminal.
    // A notice that only reports what happened teaches the user to dismiss notices.
    body:
      `${chip} ran “${def.title}” instead of reaching your terminal. You can remap it, ` +
      'or switch to terminal-first so terminals keep every chord.'
  }
}
