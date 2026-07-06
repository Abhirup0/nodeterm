import { describe, it, expect } from 'vitest'
import { accountChipLabel } from './workspace'
import type { ClaudeAccount } from '@shared/types'

const acct = (over: Partial<ClaudeAccount>): ClaudeAccount => ({
  id: 'a1',
  label: 'work@example.com',
  email: 'work@example.com',
  createdAt: 0,
  ...over
})

describe('accountChipLabel', () => {
  it('returns null when there is no accountId (no chip)', () => {
    expect(accountChipLabel(undefined, [acct({})])).toBeNull()
    expect(accountChipLabel('', [acct({})])).toBeNull()
  })

  it('takes the part before @ and tooltips as "label (email)"', () => {
    const r = accountChipLabel('a1', [acct({ label: 'work@example.com', email: 'work@example.com' })])
    expect(r).toEqual({ short: 'work', tooltip: 'work@example.com (work@example.com)' })
  })

  it('caps the short label at 10 chars with an ellipsis', () => {
    const r = accountChipLabel('a1', [acct({ label: 'verylongaccountname@example.com' })])
    expect(r?.short).toBe('verylongac…')
    expect(r?.short.length).toBe(11) // 10 chars + ellipsis
  })

  it('does not truncate a base of exactly 10 chars', () => {
    const r = accountChipLabel('a1', [acct({ label: 'tenletters@x.com' })])
    expect(r?.short).toBe('tenletters')
  })

  it('omits the "(email)" suffix when the account has no email', () => {
    const r = accountChipLabel('a1', [acct({ label: 'personal', email: undefined })])
    expect(r).toEqual({ short: 'personal', tooltip: 'personal' })
  })

  it('falls back to "Unknown account" when the id no longer resolves', () => {
    expect(accountChipLabel('gone', [acct({ id: 'a1' })])).toEqual({
      short: 'Unknown account',
      tooltip: 'Unknown account'
    })
    expect(accountChipLabel('gone', [])).toEqual({
      short: 'Unknown account',
      tooltip: 'Unknown account'
    })
  })
})
