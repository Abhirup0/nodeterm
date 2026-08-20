import { describe, expect, it, vi } from 'vitest'
import type { CodexAccount } from '@shared/codex-account'
import {
  applyResolvedCodexAccounts,
  discoverResolvedCodexAccounts,
  type ResolvedCodexAccount
} from './codexAccountReconcile'

const pending = (id: string, over: Partial<CodexAccount> = {}): CodexAccount => ({
  id,
  label: 'New Codex account',
  pending: true,
  ...over
})

describe('discoverResolvedCodexAccounts', () => {
  it('discovers only authenticated pending accounts', async () => {
    const accounts: CodexAccount[] = [
      pending('a'), // authenticated
      pending('b'), // still logging in (identity null)
      { id: 'c', label: 'Settled', email: 'c@x', pending: false } // not pending → never probed
    ]
    const identity = vi.fn(async (id: string) =>
      id === 'a' ? { email: 'a@x' } : null
    )
    const resolved = await discoverResolvedCodexAccounts(accounts, identity)
    expect(resolved).toEqual<ResolvedCodexAccount[]>([{ id: 'a', email: 'a@x' }])
    // The settled account 'c' is never read — probing a non-pending account is the mutation.
    expect(identity).not.toHaveBeenCalledWith('c')
  })

  it('drops an account whose identity read throws (fail-closed, no fabrication)', async () => {
    const identity = vi.fn(async () => {
      throw new Error('unreachable host')
    })
    expect(await discoverResolvedCodexAccounts([pending('a')], identity)).toEqual([])
  })
})

describe('applyResolvedCodexAccounts', () => {
  it('promotes a generated label to the email and clears pending', () => {
    const out = applyResolvedCodexAccounts([pending('a')], [{ id: 'a', email: 'a@x' }])
    expect(out).toEqual([{ id: 'a', label: 'a@x', email: 'a@x', pending: false }])
  })

  it('keeps a user-chosen label but still captures the email', () => {
    const out = applyResolvedCodexAccounts(
      [pending('a', { label: 'Work' })],
      [{ id: 'a', email: 'a@x' }]
    )
    expect(out[0]).toMatchObject({ label: 'Work', email: 'a@x', pending: false })
  })

  it('merges against fresh state without reviving removed or already-changed accounts', () => {
    // Fresh list: 'a' was already settled by a concurrent edit; 'removed' is gone entirely.
    const fresh: CodexAccount[] = [{ id: 'a', label: 'Renamed', email: 'a@x', pending: false }]
    const resolved: ResolvedCodexAccount[] = [
      { id: 'a', email: 'stale@x' }, // must NOT clobber the already-changed row
      { id: 'removed', email: 'ghost@x' } // must NOT be revived into the list
    ]
    const out = applyResolvedCodexAccounts(fresh, resolved)
    expect(out).toEqual(fresh) // untouched
    expect(out.some((account) => account.id === 'removed')).toBe(false)
  })
})
