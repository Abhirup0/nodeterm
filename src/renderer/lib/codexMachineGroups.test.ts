import { describe, expect, it } from 'vitest'
import type { SshServer } from '@shared/ssh'
import type { CodexAccount } from '@shared/codex-account'
import {
  codexRemoteTargets,
  groupCodexAccountsByMachine,
  strayCodexAccounts
} from './codexMachineGroups'

const server = (id: string, user: string, host: string, label: string): SshServer => ({
  id,
  user,
  host,
  label
})

describe('codexRemoteTargets', () => {
  it('dedupes by host key and prefers the saved server over the active project connection', () => {
    const saved = [server('s1', 'me', 'box', 'Ubuntu WSL')]
    const active = server('p1', 'me', 'box', 'raw') // same host key me@box
    const targets = codexRemoteTargets(saved, active)
    expect(targets).toHaveLength(1)
    expect(targets[0][0]).toBe('me@box')
    expect(targets[0][1].label).toBe('Ubuntu WSL') // first (saved) wins
  })

  it('adds the active project server when it is a new host', () => {
    const targets = codexRemoteTargets([server('s1', 'me', 'box', 'Box')], server('p1', 'me', 'two', 'Two'))
    expect(targets.map(([host]) => host)).toEqual(['me@box', 'me@two'])
  })

  it('is empty with no servers', () => {
    expect(codexRemoteTargets([], null)).toEqual([])
  })
})

describe('groupCodexAccountsByMachine', () => {
  const accounts: CodexAccount[] = [
    { id: 'local-1', label: 'Home' },
    { id: 'box-1', label: 'Work', host: 'me@box' },
    { id: 'local-2', label: 'Side' },
    { id: 'two-1', label: 'Other', host: 'me@two' }
  ]
  const targets = codexRemoteTargets(
    [server('s1', 'me', 'box', 'Box'), server('s2', 'me', 'two', 'Two')],
    null
  )

  it('puts This Mac first with exactly the host-less accounts', () => {
    const groups = groupCodexAccountsByMachine(accounts, targets)
    expect(groups[0]).toMatchObject({ host: '', remote: false })
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['local-1', 'local-2'])
  })

  it('emits one panel per configured host with its own accounts', () => {
    const groups = groupCodexAccountsByMachine(accounts, targets)
    expect(groups).toHaveLength(3) // This Mac + 2 hosts
    expect(groups[1]).toMatchObject({ host: 'me@box', remote: true })
    expect(groups[1].accounts.map((a) => a.id)).toEqual(['box-1'])
    expect(groups[2].accounts.map((a) => a.id)).toEqual(['two-1'])
  })

  it('leaves a machine panel empty rather than borrowing another machine account', () => {
    const groups = groupCodexAccountsByMachine([{ id: 'box-1', label: 'W', host: 'me@box' }], targets)
    expect(groups.find((g) => g.host === 'me@two')?.accounts).toEqual([])
  })
})

describe('strayCodexAccounts', () => {
  it('surfaces a remote account whose host is not a configured target', () => {
    const accounts: CodexAccount[] = [
      { id: 'ok', label: 'W', host: 'me@box' },
      { id: 'stray', label: 'Old', host: 'me@gone' }
    ]
    const targets = codexRemoteTargets([server('s1', 'me', 'box', 'Box')], null)
    expect(strayCodexAccounts(accounts, targets).map((a) => a.id)).toEqual(['stray'])
  })

  it('never counts a local account as a stray', () => {
    expect(strayCodexAccounts([{ id: 'l', label: 'H' }], [])).toEqual([])
  })
})
