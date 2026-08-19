import { useEffect, useState } from 'react'
import { FIRST_SECTION_ID, type SettingsSectionId } from './nav'

export interface SettingsTarget {
  /** Section whose pane is shown when the search box is empty. */
  active: SettingsSectionId
  setActive: (id: SettingsSectionId) => void
  /** Current search query. Empty = no filtering. */
  query: string
  setQuery: (q: string) => void
}

/**
 * What the settings dialog is currently pointed at, and how a caller re-points it.
 *
 * Its own hook (rather than two `useState`s inline in SettingsPage) because the retarget rule is
 * the load-bearing half of the deep-link feature and SettingsPage itself is untestable in
 * isolation — rendering it mounts ~25 section modules, every one of which reaches for the preload
 * API on mount.
 *
 * The rule:
 * - A deep link (`initialSection` + a BUMPED `retargetNonce`) selects that section AND clears the
 *   query. Without the clear, a filter still sitting in the search box would hide the very pane
 *   the link just navigated to — the nav row would highlight over an empty page.
 * - The nonce is what makes a REPEAT of the same section re-target: `initialSection` alone would
 *   not change, so the effect would not re-run.
 * - Plain opens (the gear, ⌘, , the native menu) pass no section and never bump the nonce, so a
 *   query or a section the user chose inside the dialog survives.
 */
export function useSettingsTarget(
  initialSection: SettingsSectionId | undefined,
  retargetNonce: number | undefined
): SettingsTarget {
  const [active, setActive] = useState<SettingsSectionId>(initialSection ?? FIRST_SECTION_ID)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!initialSection) return
    setActive(initialSection)
    setQuery('')
  }, [initialSection, retargetNonce])

  return { active, setActive, query, setQuery }
}
