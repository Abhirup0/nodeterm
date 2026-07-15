// Monthly free-tier quota for relay remote access (spec docs/superpowers/specs/
// 2026-07-15-nodeterm-pro-mobile-paywall-design.md §4). Pro (license.ts isPremium)
// bypasses. Unit: (peerKey, local day) — the same phone re-bridging on the same local
// day never consumes a second use. The month derives from max(now, lastSeen), so a
// rolled-back clock can neither mint a fresh month nor revive a day.
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import { isPremium } from './license'
import type { RelayQuotaStatus } from '../shared/types'

export const RELAY_QUOTA_LIMIT = 5

interface Stored {
  month?: string // '2026-07'
  entries?: { peer: string; day: string }[] // day: '2026-07-15' (local)
  /** Largest unix-seconds timestamp this install has observed — the clock-rollback anchor. */
  lastSeen?: number
}

function file(): string {
  return path.join(platform().userDataDir, 'relay-quota.json')
}
function load(): Stored {
  try {
    return JSON.parse(readFileSync(file(), 'utf-8')) as Stored
  } catch {
    return {}
  }
}
// Synchronous so consecutive consumeRelayUse() calls (a sync API) observe prior
// entries — a fresh readFileSync load in each call must see the previous write.
function save(s: Stored): void {
  try {
    writeFileSync(file(), JSON.stringify(s), 'utf-8')
  } catch {
    // best-effort persistence; a failed write must never crash a bridge admission
  }
}

function effectiveNow(s: Stored): Date {
  return new Date(Math.max(Date.now(), (s.lastSeen ?? 0) * 1000))
}
function dayOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Load, roll into the current (anchored) month, and advance the anchor. */
function normalized(): Required<Stored> {
  const s = load()
  const day = dayOf(effectiveNow(s))
  const month = day.slice(0, 7)
  const lastSeen = Math.max(s.lastSeen ?? 0, Math.floor(Date.now() / 1000))
  if (s.month !== month) return { month, entries: [], lastSeen }
  return { month, entries: s.entries ?? [], lastSeen }
}

export type RelayConsume =
  | { kind: 'unlimited' }
  | { kind: 'ok'; used: number; limit: number }
  | { kind: 'already'; used: number; limit: number }
  | { kind: 'exhausted'; used: number; limit: number }

export function relayQuotaStatus(): RelayQuotaStatus {
  const s = normalized()
  return {
    month: s.month,
    used: s.entries.length,
    limit: RELAY_QUOTA_LIMIT,
    unlimited: isPremium()
  }
}

/**
 * True when a relay bridge could be admitted right now: Pro, a free slot left, or at
 * least one peer already counted TODAY (that peer may reconnect for free). Used by the
 * standing host's reconcile to decide whether hosting is worth running at all.
 */
export function relayQuotaAvailable(): boolean {
  if (isPremium()) return true
  const s = normalized()
  if (s.entries.length < RELAY_QUOTA_LIMIT) return true
  const today = dayOf(effectiveNow(s))
  return s.entries.some((e) => e.day === today)
}

export function broadcastRelayQuota(): void {
  platform().broadcast(IPC.relayQuotaChanged, relayQuotaStatus())
}

/** Admit-or-refuse a relay bridge from `peerKey`, consuming a (peer, day) slot if fresh. */
export function consumeRelayUse(peerKey: string): RelayConsume {
  if (isPremium()) return { kind: 'unlimited' }
  const s = normalized()
  const day = dayOf(effectiveNow(s))
  if (s.entries.some((e) => e.peer === peerKey && e.day === day)) {
    save(s) // persist the advanced anchor / month rollover
    return { kind: 'already', used: s.entries.length, limit: RELAY_QUOTA_LIMIT }
  }
  if (s.entries.length >= RELAY_QUOTA_LIMIT) {
    save(s)
    return { kind: 'exhausted', used: s.entries.length, limit: RELAY_QUOTA_LIMIT }
  }
  s.entries.push({ peer: peerKey, day })
  save(s)
  broadcastRelayQuota()
  return { kind: 'ok', used: s.entries.length, limit: RELAY_QUOTA_LIMIT }
}

export function initRelayQuota(): void {
  platform().handle(IPC.relayQuotaStatus, () => relayQuotaStatus())
}
