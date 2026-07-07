import { useEffect, useState } from 'react'
import type { ClaudeAccount } from '@shared/types'
import { sshHostKey } from '@shared/ssh'
import { useSettings } from '../../../state/settings'
import { useSystemAccount } from '../../../state/systemAccount'
import { useProjects } from '../../../state/projects'
import { useSshConn } from '../../../state/sshConn'
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
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  useEffect(() => useSystemAccount.getState().ensure(), [])
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === activeProjectId))
  // The active project's SSH host key (`user@host`), when it's a connected SSH project. Present →
  // the "Add account" control also offers adding an account ON that host.
  const activeHostKey = activeProject?.ssh ? sshHostKey(activeProject.ssh.server) : undefined
  // Subscribe to live SSH connections so a remote account's Retry button enables/disables as its
  // host connects/disconnects while this panel is open.
  const sshByProject = useSshConn((s) => s.byProject)
  const [versionWarning, setVersionWarning] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<ClaudeAccount | null>(null)

  const setLabel = (id: string, label: string): void =>
    applyAccounts((accs) => accs.map((a) => (a.id === id ? { ...a, label } : a)))

  // The open project whose SSH host matches a remote account (needed for the ssh context of
  // waitLogin / remove). Undefined for local accounts, or when no such project is open.
  const projectIdForHost = (host?: string): string | undefined => {
    if (!host) return undefined
    return useProjects.getState().projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host)?.id
  }

  // A remote account can only log in on a CONNECTED matching-host project (live ControlMaster in
  // useSshConn). Undefined when the account is remote but no such project is currently connected —
  // Retry is then disabled so `claude /login` never runs against the local system account.
  const connectedProjectIdForHost = (host?: string): string | undefined => {
    const id = projectIdForHost(host)
    return id && sshByProject[id] ? id : undefined
  }

  // Open a login terminal for an account and wait (up to ~5 min) for the CLI to write its
  // credentials; on success flip the row out of `pending` and adopt the captured email. A remote
  // account (`host` set) logs in on its host: the login node runs in remote tmux and waitLogin polls
  // the remote `.claude.json` over ssh (via the ctx `projectId`).
  const runLogin = async (account: Pick<ClaudeAccount, 'id' | 'host'>): Promise<void> => {
    const remote = !!account.host
    const projectId = remote ? projectIdForHost(account.host) : undefined
    // Carry `host` so Canvas resolves the ssh binding BY HOST (among connected projects), not from
    // whatever project happens to be active when Retry fires.
    window.dispatchEvent(
      new CustomEvent('nodeterm:add-account-login', {
        detail: { accountId: account.id, remote, host: account.host }
      })
    )
    const captured = await window.nodeTerminal.claudeAccounts.waitLogin(
      account.id,
      projectId ? { projectId } : undefined
    )
    if (!captured) return // timeout / cancel: row stays pending, offers Retry
    applyAccounts((accs) =>
      accs.map((a) =>
        a.id === account.id
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

  // `host` set → create the account dir + hook ON that SSH host (via the ctx projectId); the row
  // then carries the host chip and only appears in that host's projects.
  const onAddAccount = async (host?: string): Promise<void> => {
    const projectId = host ? projectIdForHost(host) : undefined
    const { id, versionSupported } = await window.nodeTerminal.claudeAccounts.add(
      projectId ? { projectId } : undefined
    )
    // Non-blocking: the account still isolates config, but an old CLI's unscoped macOS keychain
    // service would collide across accounts — surface a dismissable warning.
    if (!versionSupported) setVersionWarning(true)
    const account: ClaudeAccount = {
      id,
      label: 'New account',
      pending: true,
      createdAt: Date.now(),
      ...(host ? { host } : {})
    }
    applyAccounts((accs) => [...accs, account])
    await runLogin(account)
  }

  const confirmRemove = async (account: ClaudeAccount): Promise<void> => {
    setPendingRemove(null)
    // Removing a pending account: stop the 5-minute waitLogin poll loop first.
    if (account.pending) await window.nodeTerminal.claudeAccounts.cancelWaitLogin(account.id)
    const projectId = projectIdForHost(account.host)
    await window.nodeTerminal.claudeAccounts.remove(
      account.id,
      projectId ? { projectId } : undefined
    )
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

          {/* The SYSTEM account (the machine's default ~/.claude login) is implicit — not a
              ClaudeAccount record — but gets a fixed row so it can be told apart from managed
              accounts: detected email as subtitle, renamable display label (empty = default). */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  className="w-56"
                  placeholder="System account"
                  value={systemLabelSetting}
                  onChange={(e) => useSettings.getState().update({ systemAccountLabel: e.target.value })}
                />
                <span
                  className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-muted"
                  title="The machine's default Claude login (~/.claude). Used when a node has no account."
                >
                  system
                </span>
              </div>
              {systemEmail ? <p className="text-[12px] text-muted">{systemEmail}</p> : null}
            </div>
          </div>

          {accounts.length === 0 ? null : (
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
                    {account.host ? (
                      <span
                        className="rounded-full bg-[#0a84ff]/15 px-2 py-0.5 text-[11px] font-medium text-[#0a84ff]"
                        title={`Remote account on ${account.host}`}
                      >
                        {account.host}
                      </span>
                    ) : null}
                  </div>
                  {account.email && !account.pending ? (
                    <p className="text-[12px] text-muted">{account.email}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {account.pending
                    ? (() => {
                        // A remote account can only retry login on a connected matching-host
                        // project; without one, disable Retry (a local spawn would log into the
                        // system account instead of the remote host).
                        const blocked = !!account.host && !connectedProjectIdForHost(account.host)
                        return (
                          <Button
                            disabled={blocked}
                            title={
                              blocked
                                ? `Connect to ${account.host} to finish logging in`
                                : undefined
                            }
                            onClick={() => void runLogin(account)}
                          >
                            Retry login
                          </Button>
                        )
                      })()
                    : null}
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

          {activeHostKey ? (
            // Inside an SSH project: choose where the new account lives. "On this Mac" is a normal
            // local account; "On <host>" creates it on the remote host (usable only there).
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void onAddAccount()}>
                Add account — On this Mac
              </Button>
              <Button variant="primary" onClick={() => void onAddAccount(activeHostKey)}>
                Add account — On {activeHostKey}
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => void onAddAccount()}>
              Add account
            </Button>
          )}

          <p className="text-[12px] leading-relaxed text-muted">
            Accounts are isolated Claude logins. New Claude nodes pick an account from the add
            menus; each node keeps its account for life. Remote accounts live on an SSH host and are
            only offered in that host&apos;s projects.
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
