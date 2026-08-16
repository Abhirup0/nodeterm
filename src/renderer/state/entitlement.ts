import { create } from 'zustand'
import type { LicenseDetail, LicenseStatus } from '@shared/types'

interface EntitlementState {
  status: LicenseStatus
  /** True when an active Pro entitlement is present — features gate on this. */
  isPremium: boolean
  /** Team seat cap (premium → max(3, N), premium-no-field → 3 = Pro's free seats, free/inactive
   *  → 0). Mirrors `status.seats` so the Team seats section can select it directly. */
  seats: number
  /** The license key + device usage, or null before the first read. `detail.error` is the read's
   *  verdict: non-null means we could not look, and its zeros are NOT a device count. */
  detail: LicenseDetail | null
  hydrate(): Promise<void>
  /** Open Stripe checkout for this device; Pro arrives via onChange when the purchase lands.
   * `target: 'seats'` opens the add-seats (quantity) link instead of base Pro. */
  upgrade(target?: 'pro' | 'seats'): Promise<void>
  activate(key: string): Promise<void>
  deactivate(): Promise<void>
  /** Read the key + device usage (token-authorized). Replaces `detail` wholesale — it is the one
   *  call that states every field. */
  loadDetail(): Promise<void>
  /** Deactivate every other device on this license, then fold the new counts into `detail`. */
  releaseOthers(): Promise<void>
}

const EMPTY: LicenseStatus = { tier: null, active: false, expiresAt: null, seats: 0, error: null }

const EMPTY_DETAIL: LicenseDetail = {
  key: null,
  used: 0,
  seats: 0,
  source: null,
  error: null
}

export const useEntitlement = create<EntitlementState>((set, get) => {
  const apply = (status: LicenseStatus) =>
    set({ status, isPremium: status.active, seats: status.seats })
  // Live updates from the main process (launch refresh, offline grace).
  window.nodeTerminal.license.onChange(apply)
  return {
    status: EMPTY,
    isPremium: false,
    seats: 0,
    detail: null,
    async hydrate() {
      apply(await window.nodeTerminal.license.getStatus())
    },
    async upgrade(target) {
      apply(await window.nodeTerminal.license.upgrade(target))
    },
    async activate(key) {
      apply(await window.nodeTerminal.license.activate(key))
    },
    async deactivate() {
      apply(await window.nodeTerminal.license.deactivate())
    },
    async loadDetail() {
      set({ detail: await window.nodeTerminal.license.detail() })
    },
    async releaseOthers() {
      const r = await window.nodeTerminal.license.releaseOthers()
      const prev = get().detail ?? EMPTY_DETAIL
      // The release route answers with COUNTS ONLY — no key, no source. Replacing `detail`
      // wholesale would blank the key the user came to this screen to copy, and drop the source
      // that decides whether this action is offered at all. And a FAILED release changed nothing
      // on the server, so its zeroed counts must not land either: only the reason code rides.
      set({
        detail: r.error
          ? { ...prev, error: r.error, retryAfterDays: r.retryAfterDays }
          : { ...prev, used: r.used, seats: r.seats, error: null, retryAfterDays: undefined }
      })
    }
  }
})
