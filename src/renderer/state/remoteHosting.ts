import { create } from 'zustand'

/**
 * Whether THIS instance is currently serving remote clients (host mode). Set by the hosting
 * UIs around remoteHost.start()/stop(). Canvas gates its canvas-mirror IPC on it: without the
 * flag every canvas edit serialized the full node array and IPC'd it to main — pure waste for
 * the (default) non-hosting case. Fail-open: if teardown happens main-side without stop(),
 * the flag stays true and we merely keep mirroring, which is the old always-on behavior.
 */
export const useRemoteHosting = create<{ hosting: boolean; setHosting(v: boolean): void }>(
  (set) => ({
    hosting: false,
    setHosting: (hosting) => set({ hosting })
  })
)
