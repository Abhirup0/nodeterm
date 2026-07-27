// What the usage indicator is allowed to talk about, given the project you are looking at.
//
// One rule: **the pill describes the machine the ACTIVE project runs on.** On a local project
// that is this machine (local Claude accounts + the other providers, whose credentials are all
// local); on an SSH project it is the host (that host's Claude accounts, and nothing else).
//
// Before this, every source was shown at once — local Claude, local managed accounts, six
// billing providers, and every connected SSH host. Each addition was individually reasonable and
// the sum was unreadable: numbers from three machines sharing one line, with nothing saying which
// was which. Scoping is what makes the panel answerable ("what am I burning HERE?") instead of a
// list of everything the app can read.
//
// Deliberately NOT filtered down to the project's own `defaultAccountId`: the local side lists
// every local identity rather than just the project default, and an SSH project listing only one
// of its host's accounts would break that symmetry — the machine is the scope, the account is a
// row within it.
import type {
  ClaudeAccount,
  ClaudeUsage,
  Project,
  ProviderUsage,
  RemoteAccountUsage
} from '@shared/types'
import { sshHostKey } from '@shared/ssh'

/** Local = this machine. SSH = the host of the active project, by `user@host`. */
export type UsageScope = { kind: 'local' } | { kind: 'ssh'; hostKey: string }

/**
 * The scope of the project you are looking at. No project, an unavailable tab, or a local folder
 * all mean "this machine". A **relay** tab (`project.remote`) is local too: its terminals live on a peer's desktop,
 * but the usage namespace is app-global and deliberately stays local (see relay-api) — a relay
 * tab shows YOUR numbers, and claiming otherwise would be a lie about someone else's quota.
 */
export function usageScopeFor(project: Project | undefined): UsageScope {
  if (!project?.ssh) return { kind: 'local' }
  const hostKey = sshHostKey(project.ssh.server)
  return hostKey ? { kind: 'ssh', hostKey } : { kind: 'local' }
}

/**
 * The scope as ONE primitive — '' for local, else the host key. Zustand compares a selector's
 * result with Object.is, and the active project object is rebuilt whenever its nodes are
 * serialized back into the store; selecting the project itself would re-render the indicator on
 * every canvas edit. Selecting this string re-renders it only when the answer actually changes.
 */
export function usageScopeKey(project: Project | undefined): string {
  const scope = usageScopeFor(project)
  return scope.kind === 'ssh' ? scope.hostKey : ''
}

/** Inverse of `usageScopeKey`. */
export function scopeFromKey(hostKey: string): UsageScope {
  return hostKey ? { kind: 'ssh', hostKey } : { kind: 'local' }
}

export interface ScopeInput {
  scope: UsageScope
  /** This machine's system-account snapshot (null while unknown / hidden by settings). */
  claude: ClaudeUsage | null
  /** Local managed accounts configured in settings (already filtered of pending ones). */
  accounts: readonly ClaudeAccount[]
  /** Non-Claude providers — all local credentials. */
  providers: readonly ProviderUsage[]
  /** Every remote row the service answered with. */
  remote: readonly RemoteAccountUsage[]
}

export interface ScopedUsage {
  /** The system-account snapshot to render as the leading Claude block, or null. */
  claude: ClaudeUsage | null
  accounts: ClaudeAccount[]
  providers: ProviderUsage[]
  remote: RemoteAccountUsage[]
  /**
   * The limits the collapsed pill spells out. On a local project that is the system account's;
   * on an SSH project the host's system account, falling back to the first identity that has
   * anything to say — a host used only through a managed account would otherwise show an empty
   * pill while its popover was full.
   *
   * Managed accounts (local OR remote) never get their own pill segment: the pill has one line
   * beside the canvas, and the popover is where per-account detail belongs. This is the rule the
   * local side has always followed; the SSH side now matches it.
   */
  pillLimits: ClaudeUsage['limits']
}

export function scopeUsage(input: ScopeInput): ScopedUsage {
  const { scope, claude, accounts, providers, remote } = input
  if (scope.kind === 'local') {
    return {
      claude,
      accounts: [...accounts],
      providers: [...providers],
      // Remote hosts are another machine's story — not this project's.
      remote: [],
      pillLimits: claude?.limits ?? []
    }
  }
  const rows = remote.filter((r) => r.hostKey === scope.hostKey)
  const system = rows.find((r) => r.accountId === null)
  const leading =
    system && system.usage.limits.length > 0
      ? system
      : (rows.find((r) => r.usage.limits.length > 0) ?? system)
  return {
    // The local machine's Claude, its managed accounts and the local billing providers are all
    // credentials you are NOT spending while you work on the host.
    claude: null,
    accounts: [],
    providers: [],
    remote: rows,
    pillLimits: leading?.usage.limits ?? []
  }
}
