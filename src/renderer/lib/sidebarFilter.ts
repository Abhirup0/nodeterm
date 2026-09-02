import type { SidebarGrouping } from './sessionList'

/**
 * Pure decisions behind the sessions sidebar's filter field (issue #505). The field was quick to
 * type into and slow to get out of: no clear button, no `type="search"` ✕, and Escape did nothing
 * — so going back to the full list meant select-all-delete. The filter also persists while you
 * work, so a list filtered half an hour ago was still filtered, still empty, and still saying
 * "No sessions yet.", which reads as a broken sidebar rather than a stale filter.
 */

/** What a keydown inside the filter field means. */
export type SidebarFilterKeyAction = 'clear' | 'ignore'

/**
 * Escape clears the filter in ONE action — but ONLY while there is text to clear. On an empty
 * field it is `ignore`, so the key is left alone and still reaches whatever owns it next (the
 * dialog stack, the drawer); a field that swallowed Escape unconditionally would be a dead end
 * for the one key users reach for to back out of things.
 */
export function sidebarFilterKeyAction(key: string, filter: string): SidebarFilterKeyAction {
  return key === 'Escape' && filter !== '' ? 'clear' : 'ignore'
}

/** Which sentence (if any) an empty sessions list should show. */
export type SidebarEmptyState = 'none' | 'no-sessions' | 'no-matches'

/**
 * "Nothing here" and "nothing matched" are different facts, and only the second one has an undo.
 *
 * `no-matches` is reported in BOTH grouping modes: status mode renders only non-empty sections,
 * so a filter that matched nothing there used to produce a completely blank panel with no
 * sentence at all. `no-sessions` stays project-mode-only, exactly as before — status mode has
 * never had an unfiltered empty state and this is not the change that adds one.
 */
export function sidebarEmptyState(
  noRows: boolean,
  filter: string,
  grouping: SidebarGrouping
): SidebarEmptyState {
  if (!noRows) return 'none'
  if (filter.trim() !== '') return 'no-matches'
  return grouping === 'status' ? 'none' : 'no-sessions'
}
