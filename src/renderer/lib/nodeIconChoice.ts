/**
 * What the icon dialog's answer MEANS, in one place.
 *
 * The dialog has three outcomes and two of them are easy to confuse, because JavaScript makes
 * `null` and `undefined` look interchangeable right up until they are not:
 *
 *   a `NodeIcon`  → set this icon
 *   `null`        → remove the icon the node has
 *   `undefined`   → cancelled; the node keeps whatever it had
 *
 * Written inline at each call site, "remove" and "cancel" collapse the moment someone writes
 * `if (!choice) return` — which reads as obviously correct and silently turns the Remove button
 * into a second Cancel. Three surfaces open this dialog, so the rule lives here once and is
 * pinned by a test rather than by three identical conditionals.
 */
import type { NodeIcon } from '@shared/node-icon'
import type { NodeIconChoice } from '../components/NodeIconPicker'

/**
 * Apply a dialog answer. `apply` is called with the new icon, or with `undefined` to clear it —
 * and is NOT called at all when the user cancelled, so a cancel never marks the canvas dirty.
 */
export function applyIconChoice(
  choice: NodeIconChoice,
  apply: (icon: NodeIcon | undefined) => void
): void {
  if (choice === undefined) return
  apply(choice ?? undefined)
}
