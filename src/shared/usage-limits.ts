// Display + selection helpers for usage limits, shared by every surface (the renderer picks
// what the pill leads with; the shells label rows the same way). Pure and dependency-free.
//
// The parsing that produces `UsageLimit[]` from a raw provider payload is service-side and
// lives in core/usage — only the vocabulary lives here.
import type { ProviderUsage, RemoteAccountUsage, UsageLimit } from './types'

/**
 * Human label for a limit. A scoped limit is named by its model ("Fable"); everything else
 * falls back to its `kind`, prettified, so an unrecognized future kind still renders as
 * something readable instead of vanishing from the UI.
 */
export function limitLabel(kind: string, scopeLabel: string | null): string {
  if (scopeLabel) return scopeLabel
  switch (kind) {
    case 'session':
      return 'Session'
    case 'weekly_all':
      return 'Weekly'
    case 'weekly_scoped':
      return 'Weekly (scoped)'
    default:
      return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
}

/** Compact label for the collapsed pill, where horizontal space is scarce. */
export function limitShortLabel(kind: string, scopeLabel: string | null): string {
  if (scopeLabel) return scopeLabel
  if (kind === 'session') return '5h'
  if (kind === 'weekly_all') return 'wk'
  return limitLabel(kind, scopeLabel)
}

/**
 * The one limit the collapsed pill leads with: whatever is closest to biting. The server's
 * `is_active` flag wins over raw percentage — it knows which window is actually gating the
 * account right now — and percentage only breaks ties.
 */
export function primaryLimit(limits: UsageLimit[]): UsageLimit | null {
  if (limits.length === 0) return null
  return limits.reduce((best, l) => {
    if (l.isActive !== best.isActive) return l.isActive ? l : best
    return l.usedPercent > best.usedPercent ? l : best
  })
}

/** Find a limit by `kind`, for the back-compat `session`/`weekly` fields. */
export function findLimit(limits: UsageLimit[], kind: string): UsageLimit | null {
  return limits.find((l) => l.kind === kind) ?? null
}

/** Stable React key / dedupe key for a limit (kind alone repeats across scoped models). */
export function limitKey(limit: UsageLimit): string {
  return `${limit.kind}:${limit.scopeLabel ?? ''}`
}

/**
 * The providers the user has actually enabled: signed in AND with something to report. Anything
 * else is noise in the pill for someone who has never used that service.
 */
export function enabledProviders(providers: ProviderUsage[]): ProviderUsage[] {
  return providers.filter((p) => p.status === 'ok' && p.limits.length > 0)
}

/**
 * Whether the usage indicator has anything to show at all.
 *
 * Deliberately NOT "is Claude available": gating on Claude alone leaves a Codex-only or
 * Gemini-only user with no indicator whatsoever. An 'error' Claude still renders, because that
 * is a configured provider failing and hiding it would make the pill flap between refreshes.
 */
export function hasAnyUsage(
  claude: { status: string } | null | undefined,
  providers: ProviderUsage[],
  remote: readonly RemoteAccountUsage[] = []
): boolean {
  if (claude && (claude.status === 'ok' || claude.status === 'error')) return true
  if (enabledProviders(providers).length > 0) return true
  // A remote row counts for the same reason a local Claude one does — and it is the whole point
  // of remote usage: someone whose Claude only ever runs on a server had no indicator at all.
  return remote.some((r) => r.usage.status === 'ok' || r.usage.status === 'error')
}

/**
 * Short, human name for an ssh `user@host` — what the collapsed pill labels a remote segment
 * with, since `deploy@build-01.internal.example.com` cannot share a row with three other
 * numbers. Bare IPs are kept whole: chopping at the first dot would turn 10.0.0.4 into "10".
 */
export function shortHostLabel(hostKey: string): string {
  const host = hostKey.includes('@') ? hostKey.slice(hostKey.indexOf('@') + 1) : hostKey
  if (!host) return hostKey
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host // IPv4 / IPv6
  const first = host.split('.')[0]
  return first || host
}

/**
 * One pill segment per remote HOST, carrying that host's worst limit.
 *
 * Per host, not per account: a host with three managed accounts would otherwise push three more
 * numbers into a pill that already shares a line with the canvas. The full per-account breakdown
 * is what the popover is for.
 */
export function remotePillSegments(
  remote: readonly RemoteAccountUsage[]
): { hostKey: string; label: string; limit: UsageLimit }[] {
  const byHost = new Map<string, UsageLimit[]>()
  for (const r of remote) {
    if (r.usage.status !== 'ok' || r.usage.limits.length === 0) continue
    const acc = byHost.get(r.hostKey)
    if (acc) acc.push(...r.usage.limits)
    else byHost.set(r.hostKey, [...r.usage.limits])
  }
  const out: { hostKey: string; label: string; limit: UsageLimit }[] = []
  for (const [hostKey, limits] of byHost) {
    const worst = primaryLimit(limits)
    if (worst) out.push({ hostKey, label: shortHostLabel(hostKey), limit: worst })
  }
  return out
}

/**
 * Every usage source the app can read, in display order — Claude first (the primary agent) with
 * its SSH-host variant beside it, then the rest alphabetically. The Settings toggles iterate
 * this, so a new provider gets its on/off switch by being added here.
 *
 * `claude-remote` is not a provider but a SOURCE of Claude usage (the accounts on connected SSH
 * hosts). It gets its own switch because the cost profile differs: those rows are read over an
 * ssh round-trip on someone else's machine, so wanting Claude usage without them is a reasonable
 * position — and the local toggle must not silently take remote hosts down with it.
 */
export const USAGE_PROVIDER_IDS = [
  'claude',
  'claude-remote',
  'codex',
  'gemini',
  'grok',
  'kimi',
  'minimax',
  'opencode'
] as const

/**
 * Display names for usage providers that are NOT builtin agents — Grok, Kimi and the rest are
 * billing relationships we can read, not CLIs nodeterm spawns, so they have no AGENT_CONFIG
 * entry to borrow a label from.
 */
const PROVIDER_LABELS: Record<string, string> = {
  'claude-remote': 'Claude on SSH hosts',
  grok: 'Grok',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  opencode: 'opencode'
}

/**
 * Label a provider for the popover. Prefers the builtin agent's own label (passed in by the
 * renderer, which is where AGENT_CONFIG lives), then the table above, then the raw id — so a
 * provider added to the registry always renders as something rather than a blank heading.
 */
export function providerLabel(provider: string, agentLabel?: string): string {
  return agentLabel ?? PROVIDER_LABELS[provider] ?? provider
}
