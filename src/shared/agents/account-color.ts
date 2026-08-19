import type { ClaudeAccount } from '../types'

/**
 * The default node color a managed Claude account carries, or undefined for "use the agent's own".
 *
 * `typeof` first, not just optional chaining: `claudeAccounts` comes out of a hand-editable
 * settings.json that nothing validates field-by-field on load (`mergeSettings` merges, it does not
 * check), so a `"color": 123` arrives here verbatim — and `.trim()` on it throws inside
 * `createAgentNode`, i.e. every new node under that account stops opening with nothing pointing
 * back at the edited file. Same discipline as `appendProjectNode`'s account-id guard.
 * A whitespace-only color is unset too: an empty `data.color` renders a node transparent.
 */
export function accountNodeColor(
  accountId: string | undefined,
  accounts: ClaudeAccount[]
): string | undefined {
  if (!accountId) return undefined
  const color = accounts.find((a) => a.id === accountId)?.color
  if (typeof color !== 'string') return undefined
  return color.trim() || undefined
}
