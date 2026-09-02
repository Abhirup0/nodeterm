// S6 PR 8 — the single account-display contract shared by settings, node chrome, and account
// menus. Based on @Corvin's #112 (`src/renderer/lib/accountPresentation.ts`).
//
// This module is renderer-pure: it imports nothing from `src/core`, so presenting an account
// never drags the impure core path machinery into the bundle.

import { thisMachineCap } from './machineName'

export interface AccountPresentation {
  /** Human identity: a chosen account name, otherwise the login email. */
  identity: string
  /** Short origin pill rendered beside the identity on every account surface. */
  provenance: string
  /** Full, stable explanation for native tooltips. */
  tooltip: string
}

/**
 * Auto-generated placeholder labels that must NOT be shown as a chosen identity — a row still
 * carrying one of these has never been named by the user, so we fall through to the email (or
 * "Default account"). Kept lowercase; matched case-insensitively.
 */
const GENERATED_LABELS = new Set([
  'new account',
  'new codex account',
  'system account',
  'system codex account'
])

function chosenLabel(label: string | null | undefined): string | undefined {
  const value = label?.trim()
  if (!value || GENERATED_LABELS.has(value.toLowerCase())) return undefined
  return value
}

/**
 * Single account-display contract shared by settings, node chrome, and account menus.
 *
 * The *credential storage kind* (system vs managed directory) is deliberately NOT user-facing:
 * users select a person/login and the machine it lives on, not an implementation directory. The
 * only origin fact surfaced is machine provenance — `Local` or `SSH · <machineLabel>`.
 */
export function presentAccount({
  label,
  email,
  host,
  machineLabel
}: {
  label?: string | null
  email?: string | null
  /** Canonical SSH address (`user@host`). Omit for an account on this machine. */
  host?: string | null
  /** Friendly saved SSH-machine name. */
  machineLabel?: string | null
}): AccountPresentation {
  const displayLabel = chosenLabel(label)
  const cleanEmail = email?.trim() || undefined
  const identity = displayLabel || cleanEmail || 'Default account'
  const provenance = host ? `SSH · ${machineLabel?.trim() || host}` : 'Local'
  const originDetail = host ? `SSH ${host}` : thisMachineCap()
  const identityDetail =
    cleanEmail && cleanEmail !== identity ? `${identity} (${cleanEmail})` : identity
  return {
    identity,
    provenance,
    tooltip: `${identityDetail} · ${originDetail}`
  }
}
