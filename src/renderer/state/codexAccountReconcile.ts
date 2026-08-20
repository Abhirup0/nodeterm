// S6 PR 8 — reconcile pending Codex accounts against the app-servers' live identity, without
// trusting attacker-controlled settings fields. Based on @Corvin's #112
// (`src/renderer/state/codexAccountReconcile.ts`).
//
// `discover` reads only the identity the account home actually holds (an authenticated `auth.json`
// yielded an email); `apply` merges that against a FRESH accounts list so a login that resolves
// late can never revive an account the user removed, nor clobber one that already changed. Nothing
// here fabricates an account: an unauthenticated / unreadable home drops out of the resolved set.

import type { CodexAccount } from '@shared/codex-account'

export interface ResolvedCodexAccount {
  id: string
  email: string | null
}

/**
 * Read the live identity of every PENDING account (only pending ones are still waiting on a
 * login). A home that has not authenticated — `identity` resolves null or throws — is omitted, so
 * the resolved set is exactly the accounts that genuinely logged in. `identity` is the caller's
 * bound reader (local `codexAccounts.identity`, or the host reader behind a live connection).
 */
export async function discoverResolvedCodexAccounts(
  accounts: readonly CodexAccount[],
  identity: (id: string) => Promise<{ email: string | null } | null>
): Promise<ResolvedCodexAccount[]> {
  const resolved = await Promise.all(
    accounts
      .filter((account) => account.pending)
      .map(async (account) => ({
        id: account.id,
        identity: await identity(account.id).catch(() => null)
      }))
  )
  return resolved.flatMap(({ id, identity: value }) =>
    value ? [{ id, email: value.email }] : []
  )
}

/**
 * Merge resolved identities onto the CURRENT accounts list. Fail-closed against staleness:
 * - only an account still present in `accounts` is touched (a removed id is never re-added — the
 *   result is `accounts.map(...)`, which can only transform existing rows, never append);
 * - only an account still `pending` is promoted (`!account.pending` short-circuits, so a row that
 *   already changed under a concurrent edit is left exactly as the user left it);
 * - a generated "New Codex account" label is promoted to the captured email; a user-chosen label
 *   is preserved.
 */
export function applyResolvedCodexAccounts(
  accounts: readonly CodexAccount[],
  resolved: readonly ResolvedCodexAccount[]
): CodexAccount[] {
  const byId = new Map(resolved.map((account) => [account.id, account]))
  return accounts.map((account) => {
    const identity = byId.get(account.id)
    if (!identity || !account.pending) return account
    return {
      ...account,
      label:
        account.label === 'New Codex account' && identity.email ? identity.email : account.label,
      email: identity.email ?? undefined,
      pending: false
    }
  })
}
