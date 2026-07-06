import { useState } from 'react'
import type { ClaudeAccount } from '@shared/types'
import { useSettings } from '../../../state/settings'
import { useProjects } from '../../../state/projects'
import { ConfirmDialog } from '../../ConfirmDialog'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  accounts: {
    title: 'Claude accounts',
    keywords: ['account', 'claude', 'login', 'isolated', 'multi', 'email']
  }
}
const ENTRIES = Object.values(ROWS)

/** Reads fresh settings then applies a transform to the accounts list (avoids stale closures
 *  after an awaited login resolves late). */
function applyAccounts(fn: (accs: ClaudeAccount[]) => ClaudeAccount[]): void {
  const s = useSettings.getState()
  s.update({ claudeAccounts: fn(s.settings.claudeAccounts) })
}

/** Counts nodes bound to an account across every project's SERIALIZED nodes. The active
 *  project's live React Flow edits since the last commit aren't reflected here, so the count
 *  can be slightly stale for the active canvas — acceptable for a confirmation warning. */
function countNodesUsing(accountId: string): number {
  return useProjects
    .getState()
    .projects.reduce(
      (sum, p) => sum + p.nodes.filter((n) => n.accountId === accountId).length,
      0
    )
}

export function AccountsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const accounts = useSettings((s) => s.settings.claudeAccounts)
  const [versionWarning, setVersionWarning] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<ClaudeAccount | null>(null)

  const setLabel = (id: string, label: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label } : a)))

  // Open a login terminal for an account and wait (up to ~5 min) for the CLI to write its
  // credentials; on success flip the row out of `pending` and adopt the captured email.
  const runLogin = async (id: string): Promise<void> => {
    window.dispatchEvent(new CustomEvent('nodeterm:add-account-login', { detail: { accountId: id } }))
    const captured = await window.nodeTerminal.claudeAccounts.waitLogin(id)
    if (!captured) return // timeout / cancel: row stays pending, offers Retry
    applyAccounts((accs) =>
      accs.map((a) =>
        a.id === id
          ? {
              ...a,
              label: a.label === 'New account' ? captured.email : a.label,
              email: captured.email,
              pending: false
            }
          : a
      )
    )
  }

  const onAddAccount = async (): Promise<void> => {
    const { id, versionSupported } = await window.nodeTerminal.claudeAccounts.add()
    // Non-blocking: the account still isolates config, but an old CLI's unscoped macOS keychain
    // service would collide across accounts — surface a dismissable warning.
    if (!versionSupported) setVersionWarning(true)
    const account: ClaudeAccount = {
      id,
      label: 'New account',
      pending: true,
      createdAt: Date.now()
    }
    applyAccounts((accs) => [...accs, account])
    await runLogin(id)
  }

  const confirmRemove = async (account: ClaudeAccount): Promise<void> => {
    setPendingRemove(null)
    // Removing a pending account: stop the 5-minute waitLogin poll loop first.
    if (account.pending) await window.nodeTerminal.claudeAccounts.cancelWaitLogin(account.id)
    await window.nodeTerminal.claudeAccounts.remove(account.id)
    applyAccounts((accs) => accs.filter((a) => a.id !== account.id))
    // Clear the account off serialized nodes (all projects) + any project default...
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        ...(p.defaultAccountId === account.id ? { defaultAccountId: undefined } : {}),
        nodes: p.nodes.map((n) =>
          n.accountId === account.id ? { ...n, accountId: undefined } : n
        )
      }))
    }))
    // ...and off the active project's LIVE nodes (Canvas listener patches React Flow).
    window.dispatchEvent(
      new CustomEvent('nodeterm:account-removed', { detail: { accountId: account.id } })
    )
  }

  const removeMessage = (a: ClaudeAccount): string => {
    const n = countNodesUsing(a.id)
    return `Remove account "${a.label}"? Its logged-in credentials and all its Claude transcripts will be deleted. ${n} node(s) currently use it and will fall back to the system account.`
  }

  return (
    <SettingsSection
      id="accounts"
      title="Accounts"
      description="Isolated Claude logins. Each account has its own config dir, credentials, and transcripts; a node keeps the account it was created with for life."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.accounts}>
        <div className="space-y-4">
          {versionWarning ? (
            <div className="flex items-start justify-between gap-3 rounded-md border border-[#ff453a]/40 bg-[#ff453a]/10 px-3 py-2 text-[13px] leading-relaxed text-[#ff453a]">
              <span>
                Your installed Claude CLI is older than the version that scopes credentials per
                config dir. Accounts still isolate their config, but on macOS logins may collide in
                the shared keychain. Update the Claude CLI to keep them fully separate.
              </span>
              <button
                className="shrink-0 cursor-pointer text-muted hover:text-text"
                onClick={() => setVersionWarning(false)}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {accounts.length === 0 ? (
            <p className="text-[13px] text-muted">No accounts yet.</p>
          ) : (
            accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Input
                      className="w-56"
                      placeholder="Account label"
                      value={account.label}
                      onChange={(e) => setLabel(account.id, e.target.value)}
                    />
                    {account.pending ? (
                      <span className="rounded-full bg-[#ff9f0a]/15 px-2 py-0.5 text-[11px] font-medium text-[#ff9f0a]">
                        pending
                      </span>
                    ) : null}
                  </div>
                  {account.email && !account.pending ? (
                    <p className="text-[12px] text-muted">{account.email}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {account.pending ? (
                    <Button onClick={() => void runLogin(account.id)}>Retry login</Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    aria-label="Remove account"
                    onClick={() => setPendingRemove(account)}
                  >
                    ×
                  </Button>
                </div>
              </div>
            ))
          )}

          <Button variant="primary" onClick={() => void onAddAccount()}>
            Add account
          </Button>

          <p className="text-[12px] leading-relaxed text-muted">
            Accounts are isolated Claude logins. New Claude nodes pick an account from the add
            menus; each node keeps its account for life.
          </p>
        </div>
      </SearchableRow>

      {pendingRemove ? (
        <ConfirmDialog
          message={removeMessage(pendingRemove)}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemove(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
    </SettingsSection>
  )
}
