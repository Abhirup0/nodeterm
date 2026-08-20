// S6 PR 8 — the renderer-side gates for the Codex account switch/create UI. The actual
// authorization is main-side (PR 5's three-phase, owner-authorized switch); NOTHING here is the
// security boundary. These are the renderer's own fail-closed refusals so the UI can never
// ORIGINATE an unauthorized or fail-open switch:
//   1. `codexAccountSwitchStillEligible` — the source pane may be recycled only if it is still the
//      exact idle conversation the user chose when the fork began (Corvin's #112 guard).
//   2. `codexAccountSelectable` — an explicitly selected account that is MISSING, unsafe, or a
//      remote account with no live connection is REFUSED; the UI never silently falls back to
//      another login (§5 Property 4 / Decision 2).
//
// READERS / follow-up wiring:
//   - `codexAccountSelectable` is consumed today by the Accounts settings UI
//     (`AccountsSection.tsx`), which drives each Codex row's operable/warning state through it — one
//     definition of "operable" for the surface PR 8 builds. It is ALSO the gate the "New Codex
//     node" account picker must route every pick through once that picker exists. That picker is a
//     FOLLOW-UP (surface §3.4): the base node factory deliberately refuses a non-Claude accountId
//     (`createAgentNode` in `state/workspace.ts` stamps `accountId` only when `agentId==='claude'`)
//     and `addAgentNode` validates against `claudeAccounts`, so wiring a Codex picker first needs
//     the factory/creation path to carry codex account ids. The pty spawn side already honours one
//     (`pty-manager.ts` applies `codexSessionEnv` and fails closed on a missing home).
//   - `codexAccountSwitchStillEligible` is the recycle gate the account-SWITCH menu (surface §3.5)
//     must consult before reusing the source pane. That menu is a FOLLOW-UP: the renderer switch
//     bridge (`codexAccounts.switchThread` et al.) is still a stub, so no switch is originated in
//     the renderer yet. When the switch menu lands it MUST gate recycle on this function.

import type { CodexAccount } from '@shared/codex-account'
import { isSafeAccountId } from '@shared/codex-account'
import { restartEligibility } from '../terminal/agent-restart'

export interface CodexAccountSwitchState {
  accountId?: string
  agentId?: string
  cwd?: string
  sessionId?: string
  ssh?: boolean
  state?: string
}

/**
 * The account fork can take seconds. Nothing may recycle the source pane unless it is still the
 * exact idle conversation that the user chose when the fork began. The `sessionId` equality is the
 * "resume the same conversation id, never fork" enforcement — a pane whose thread has diverged is
 * never recycled onto the switched account.
 */
export function codexAccountSwitchStillEligible(
  expected: Required<Pick<CodexAccountSwitchState, 'agentId' | 'cwd' | 'sessionId'>> &
    Pick<CodexAccountSwitchState, 'accountId' | 'ssh'>,
  current: CodexAccountSwitchState
): boolean {
  return (
    current.agentId === expected.agentId &&
    current.agentId === 'codex' &&
    !!current.ssh === !!expected.ssh &&
    current.cwd === expected.cwd &&
    current.accountId === expected.accountId &&
    current.sessionId === expected.sessionId &&
    restartEligibility('codex', current.state, current.sessionId).ok
  )
}

/**
 * Why a chosen Codex account cannot be launched/switched to right now. Fail-closed verdicts only —
 * the absence of a reason (`{ ok: true }`) is the sole path that proceeds.
 */
export type CodexAccountSelectability =
  | { ok: true }
  | {
      /** `unavailable` — the id names no known/safe account (a missing or hostile selection).
       *  `no-connection` — a remote account whose host is not currently connected. */
      ok: false
      reason: 'unavailable' | 'no-connection'
    }

/**
 * Fail-closed gate for the create/switch menus (§5 Property 4). `selectedId` empty/undefined = the
 * SYSTEM account on this Mac (always selectable). Any managed id must:
 *   - pass `isSafeAccountId` — a hostile settings/relay id never becomes a launch target;
 *   - name an account still present in `accounts` — an explicitly selected MISSING account is
 *     refused, never silently resolved to the system or another login;
 *   - for a remote account, have a live connection — `connectedProjectIdForHost(host)` must return
 *     a project id, else the switch is refused rather than run against the local login.
 *
 * The UI must proceed ONLY on `{ ok: true }`; every other verdict shows the account as unavailable
 * and does nothing.
 */
export function codexAccountSelectable(
  selectedId: string | undefined,
  accounts: readonly CodexAccount[],
  connectedProjectIdForHost: (host: string) => string | undefined
): CodexAccountSelectability {
  // The system account (no id) always lives on this Mac — nothing to connect to, nothing to miss.
  if (!selectedId) return { ok: true }
  // Supply-chain: an id that could escape the filesystem is never a valid selection.
  if (!isSafeAccountId(selectedId)) return { ok: false, reason: 'unavailable' }
  const account = accounts.find((candidate) => candidate.id === selectedId)
  // Explicitly selected but absent from the known set ⇒ refuse (never fall back to another login).
  if (!account) return { ok: false, reason: 'unavailable' }
  // A remote account is only operable while its host is connected; without a live connection the
  // op would run against the LOCAL login — the exact fail-open Property 4 forbids.
  if (account.host && !connectedProjectIdForHost(account.host)) {
    return { ok: false, reason: 'no-connection' }
  }
  return { ok: true }
}
