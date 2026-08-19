import { describe, expect, it } from 'vitest'
import type { CodexAccount } from '@shared/codex-account'
import { resolveNewCodexNodeAccount } from './codex-account-ops'

const local: CodexAccount = { id: 'account-a', label: 'Work' }
const remote: CodexAccount = { id: 'account-r', label: 'Box', host: 'u@box' }
const accounts = [local, remote]
const connected = (host: string): string | undefined => (host === 'u@box' ? 'proj-1' : undefined)
const noConnection = (): undefined => undefined

describe('resolveNewCodexNodeAccount (fail-closed New Codex picker — §3.4 / Property 4)', () => {
  it('creates on the system account when nothing is picked', () => {
    expect(resolveNewCodexNodeAccount(undefined, accounts, noConnection)).toEqual({
      create: true,
      accountId: undefined
    })
    expect(resolveNewCodexNodeAccount('', accounts, noConnection)).toEqual({
      create: true,
      accountId: undefined
    })
  })

  it('creates on a present local managed account', () => {
    expect(resolveNewCodexNodeAccount('account-a', accounts, noConnection)).toEqual({
      create: true,
      accountId: 'account-a'
    })
  })

  it('REFUSES an explicitly picked MISSING account — no silent substitution to system', () => {
    // MUTATION PIN: if a refused selection fell back to `{ create: true, accountId: undefined }`
    // (the system login) instead of refusing, this goes green — a missing pick would silently bind
    // the system account. Must stay red.
    expect(resolveNewCodexNodeAccount('account-gone', accounts, connected)).toEqual({
      create: false,
      reason: 'unavailable'
    })
  })

  it('REFUSES a hostile (path-escaping) id even when a matching row is present', () => {
    const hostile: CodexAccount = { id: '../escape', label: 'evil' }
    expect(resolveNewCodexNodeAccount('../escape', [...accounts, hostile], connected)).toEqual({
      create: false,
      reason: 'unavailable'
    })
  })

  it('REFUSES a remote account whose host is not connected — never binds it locally', () => {
    expect(resolveNewCodexNodeAccount('account-r', accounts, noConnection)).toEqual({
      create: false,
      reason: 'no-connection'
    })
  })
})
