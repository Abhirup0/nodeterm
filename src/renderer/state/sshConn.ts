import { create } from 'zustand'

/**
 * Transient map of SSH project id → the live ControlMaster `controlPath` returned by
 * `sshProject.connect`. Not persisted: it's re-established on every launch by Canvas's
 * active-project effect. A remote terminal node reads its project's controlPath here to pass
 * `sshRemote` into `transport.create`, so the PTY runs over the project's master.
 */
interface SshConnState {
  byProject: Record<string, string>
  setControlPath(projectId: string, controlPath: string): void
  getControlPath(projectId: string): string | undefined
  clear(projectId: string): void
}

export const useSshConn = create<SshConnState>((set, get) => ({
  byProject: {},
  setControlPath(projectId, controlPath) {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: controlPath } }))
  },
  getControlPath(projectId) {
    return get().byProject[projectId]
  },
  clear(projectId) {
    set((s) => {
      const next = { ...s.byProject }
      delete next[projectId]
      return { byProject: next }
    })
  }
}))
