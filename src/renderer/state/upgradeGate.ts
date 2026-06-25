import { create } from 'zustand'
import { useEntitlement } from './entitlement'

interface UpgradeGateState {
  open: boolean
  feature: string
  show(feature: string): void
  hide(): void
}

export const useUpgradeGate = create<UpgradeGateState>((set) => ({
  open: false,
  feature: '',
  show(feature) {
    set({ open: true, feature })
  },
  hide() {
    set({ open: false })
  }
}))

/** Run `run` when the user is Pro; otherwise open the upgrade dialog for `feature`. */
export function requireProOr(feature: string, run: () => void): void {
  if (useEntitlement.getState().isPremium) run()
  else useUpgradeGate.getState().show(feature)
}
