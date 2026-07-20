import { create } from 'zustand'
import type { LicenseStatus } from '@shared/types'

interface EntitlementState {
  status: LicenseStatus
  /** True when an active Pro entitlement is present — features gate on this. */
  isPremium: boolean
  /** Team seat cap (premium → max(3, N), premium-no-field → 3 = Pro's free seats, free/inactive
   *  → 0). Mirrors `status.seats` so the Team seats section can select it directly. */
  seats: number
  hydrate(): Promise<void>
  /** Open Stripe checkout for this device; Pro arrives via onChange when the purchase lands.
   * `target: 'seats'` opens the add-seats (quantity) link instead of base Pro. */
  upgrade(target?: 'pro' | 'seats'): Promise<void>
  activate(key: string): Promise<void>
  deactivate(): Promise<void>
}

const EMPTY: LicenseStatus = { tier: null, active: false, expiresAt: null, seats: 0, error: null }

export const useEntitlement = create<EntitlementState>((set) => {
  const apply = (status: LicenseStatus) =>
    set({ status, isPremium: status.active, seats: status.seats })
  // Live updates from the main process (launch refresh, offline grace).
  window.nodeTerminal.license.onChange(apply)
  return {
    status: EMPTY,
    isPremium: false,
    seats: 0,
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
    }
  }
})
