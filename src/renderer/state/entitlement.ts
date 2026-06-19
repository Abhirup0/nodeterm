import { create } from 'zustand'
import type { LicenseStatus } from '@shared/types'

interface EntitlementState {
  status: LicenseStatus
  /** True when an active Pro entitlement is present — features gate on this. */
  isPremium: boolean
  hydrate(): Promise<void>
  /** Open Stripe checkout for this device; Pro arrives via onChange when the purchase lands. */
  upgrade(): Promise<void>
  activate(key: string): Promise<void>
  deactivate(): Promise<void>
}

const EMPTY: LicenseStatus = { tier: null, active: false, expiresAt: null, error: null }

export const useEntitlement = create<EntitlementState>((set) => {
  const apply = (status: LicenseStatus) => set({ status, isPremium: status.active })
  // Live updates from the main process (launch refresh, offline grace).
  window.nodeTerminal.license.onChange(apply)
  return {
    status: EMPTY,
    isPremium: false,
    async hydrate() {
      apply(await window.nodeTerminal.license.getStatus())
    },
    async upgrade() {
      apply(await window.nodeTerminal.license.upgrade())
    },
    async activate(key) {
      apply(await window.nodeTerminal.license.activate(key))
    },
    async deactivate() {
      apply(await window.nodeTerminal.license.deactivate())
    }
  }
})
