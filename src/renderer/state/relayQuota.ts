import { create } from 'zustand'
import type { RelayQuotaStatus } from '@shared/types'

interface RelayQuotaState {
  status: RelayQuotaStatus | null
  hydrate(): Promise<void>
}

/** Mirror of the main-process relay quota (free-tier remote-access meter). */
export const useRelayQuota = create<RelayQuotaState>((set) => {
  window.nodeTerminal.relayQuota.onChange((status) => set({ status }))
  return {
    status: null,
    async hydrate() {
      set({ status: await window.nodeTerminal.relayQuota.getStatus() })
    }
  }
})
