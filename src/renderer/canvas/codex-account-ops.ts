// S6 PR 8.5 — the two USER-FACING trigger surfaces for machine-scoped Codex accounts, wired on top
// of PR 8's fail-closed guards (`codex-account-switch.ts`). NOTHING here is the security boundary:
// owner-authorization and the atomic exposure live MAIN-SIDE (PR 5's three-phase switch), and the
// account-validity gate is `codexAccountSelectable`. These pure decisions are the renderer's own
// fail-closed refusals so the two UI surfaces can never ORIGINATE an unauthorized or fail-open op:
//   1. `resolveNewCodexNodeAccount` — the "New Codex node" account picker (§3.4). An explicitly
//      picked account that is MISSING / hostile / unconnected is REFUSED, never silently swapped for
//      the system login.

import type { CodexAccount } from '@shared/codex-account'
import { codexAccountSelectable } from './codex-account-switch'

/** The picker's verdict for a NEW Codex node. `create: false` carries the same fail-closed reason
 *  `codexAccountSelectable` produced — the node is NOT created, and never with another account. */
export type CodexCreateDecision =
  | { create: true; accountId: string | undefined }
  | { create: false; reason: 'unavailable' | 'no-connection' }

/**
 * Fail-closed account resolution for a NEW Codex node (surface §3.4). An empty/undefined selection
 * is the SYSTEM account (`~/.codex`), always creatable. Any explicit id is routed through
 * `codexAccountSelectable`; a missing, hostile, or (remote) unconnected pick is REFUSED — the caller
 * must NOT fall back to the system login or any other account (Property 4, Decision 2).
 */
export function resolveNewCodexNodeAccount(
  explicit: string | undefined,
  accounts: readonly CodexAccount[],
  connectedProjectIdForHost: (host: string) => string | undefined
): CodexCreateDecision {
  // The system account (no id) always lives on this machine — nothing to miss, nothing to connect.
  if (!explicit) return { create: true, accountId: undefined }
  const selectable = codexAccountSelectable(explicit, accounts, connectedProjectIdForHost)
  // A refused selection is NEVER downgraded to the system account — that silent substitution is the
  // exact fail-open Property 4 forbids. Refuse the creation and let the UI say why.
  if (!selectable.ok) return { create: false, reason: selectable.reason }
  return { create: true, accountId: explicit }
}
