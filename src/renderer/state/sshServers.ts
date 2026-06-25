import { create } from 'zustand'
import type { SshServer } from '@shared/ssh'

interface SshServersState {
  servers: SshServer[]
  hydrate(): Promise<void>
  save(server: SshServer): Promise<void>
  remove(id: string): Promise<void>
}

export const useSshServers = create<SshServersState>((set) => ({
  servers: [],
  async hydrate() {
    set({ servers: await window.nodeTerminal.ssh.list() })
  },
  async save(server) {
    set({ servers: await window.nodeTerminal.ssh.save(server) })
  },
  async remove(id) {
    set({ servers: await window.nodeTerminal.ssh.remove(id) })
  }
}))
