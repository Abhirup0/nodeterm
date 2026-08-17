import type { ClaudeAccount } from '../types'

export function accountNodeColor(
  accountId: string | undefined,
  accounts: ClaudeAccount[]
): string | undefined {
  if (!accountId) return undefined
  const color = accounts.find((a) => a.id === accountId)?.color?.trim()
  return color || undefined
}
