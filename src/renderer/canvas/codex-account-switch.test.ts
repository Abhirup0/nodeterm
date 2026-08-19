import { describe, expect, it } from 'vitest'
import type { CodexAccount } from '@shared/codex-account'
import { codexAccountSelectable, codexAccountSwitchStillEligible } from './codex-account-switch'

const expected = {
  accountId: 'account-a',
  agentId: 'codex',
  cwd: '/repo',
  sessionId: 'thread-a',
  ssh: false
}

describe('codexAccountSwitchStillEligible', () => {
  it('accepts only the unchanged idle source conversation', () => {
    expect(codexAccountSwitchStillEligible(expected, { ...expected, state: 'done' })).toBe(true)
  })

  it('accepts an unchanged remote source without pretending it is local', () => {
    const remote = { ...expected, ssh: true }
    expect(codexAccountSwitchStillEligible(remote, { ...remote, state: 'done' })).toBe(true)
  })

  it.each([
    { name: 'still working', current: { ...expected, state: 'working' } },
    // MUTATION PIN: drop the `sessionId` equality from the eligibility check → this case
    // (a diverged thread) goes green, i.e. a forked pane would be recycled. Must stay red.
    { name: 'sessionId diverged', current: { ...expected, sessionId: 'thread-new', state: 'done' } },
    { name: 'accountId changed', current: { ...expected, accountId: 'account-b', state: 'done' } },
    { name: 'cwd moved', current: { ...expected, cwd: '/other', state: 'done' } },
    { name: 'ssh flag flipped', current: { ...expected, ssh: true, state: 'done' } }
  ])('rejects state drift before recycle: $name', ({ current }) => {
    expect(codexAccountSwitchStillEligible(expected, current)).toBe(false)
  })
})

describe('codexAccountSelectable (fail-closed selection — Property 4)', () => {
  const local: CodexAccount = { id: 'account-a', label: 'Work' }
  const remote: CodexAccount = { id: 'account-r', label: 'Box', host: 'u@box' }
  const accounts = [local, remote]
  const connected = (host: string) => (host === 'u@box' ? 'proj-1' : undefined)
  const noConnection = () => undefined

  it('allows the system account (no id) on this Mac', () => {
    expect(codexAccountSelectable(undefined, accounts, noConnection)).toEqual({ ok: true })
    expect(codexAccountSelectable('', accounts, noConnection)).toEqual({ ok: true })
  })

  it('allows a present local managed account', () => {
    expect(codexAccountSelectable('account-a', accounts, noConnection)).toEqual({ ok: true })
  })

  it('refuses an explicitly selected MISSING account instead of falling back', () => {
    // The user picked an id that is no longer in the settings list — refuse, never resolve it to
    // the system login or any other account.
    expect(codexAccountSelectable('account-gone', accounts, connected)).toEqual({
      ok: false,
      reason: 'unavailable'
    })
  })

  it('refuses a hostile account id even when a matching row is PRESENT in settings', () => {
    // settings.json is attacker-controlled (Constraint 7): a hostile row can carry an escaping id.
    // MUTATION PIN: drop the isSafeAccountId guard → this row is FOUND (local, no host) and returns
    // { ok: true }, i.e. a path-escaping id becomes a launch target. Must stay red.
    const hostile: CodexAccount = { id: '../escape', label: 'evil' }
    expect(codexAccountSelectable('../escape', [...accounts, hostile], connected)).toEqual({
      ok: false,
      reason: 'unavailable'
    })
  })

  it('refuses a remote account with no live connection — never runs it locally', () => {
    // MUTATION PIN: drop the `account.host && !connection` gate → this goes { ok: true } and the
    // remote switch would run against the LOCAL login. Must stay red.
    expect(codexAccountSelectable('account-r', accounts, noConnection)).toEqual({
      ok: false,
      reason: 'no-connection'
    })
  })

  it('allows a remote account once its host is connected', () => {
    expect(codexAccountSelectable('account-r', accounts, connected)).toEqual({ ok: true })
  })
})
