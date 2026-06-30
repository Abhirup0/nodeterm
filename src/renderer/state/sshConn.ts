import { create } from 'zustand'

/** Live connection coordinates for one SSH project, returned by `sshProject.connect`. */
export interface SshConnInfo {
  /** ControlMaster socket path the project's terminals run their PTYs over. */
  controlPath: string
  /** Remote endpoint file the managed hook script sources (reverse-tunnel hook transport).
   *  Optional: absent when forwarding/remote install failed (fail-open → Phase-1 status). */
  hookEndpointPath?: string
  /** Remote path of the injected tmux config (`-f`), written + sourced on connect.
   *  Optional: absent when the conf write failed (fail-open → remote tmux defaults). */
  tmuxConfPath?: string
}

/**
 * Transient map of SSH project id → its live connection info (ControlMaster `controlPath` +
 * optional remote `hookEndpointPath`) returned by `sshProject.connect`. Not persisted: it's
 * re-established on every launch by Canvas's active-project effect. A remote terminal node reads
 * its project's entry here to pass `sshRemote` into `transport.create`, so the PTY runs over the
 * project's master and (when present) the remote hook env is injected.
 */
interface SshConnState {
  byProject: Record<string, SshConnInfo>
  setConn(projectId: string, info: SshConnInfo): void
  getControlPath(projectId: string): string | undefined
  getHookEndpointPath(projectId: string): string | undefined
  getTmuxConfPath(projectId: string): string | undefined
  clear(projectId: string): void
}

export const useSshConn = create<SshConnState>((set, get) => ({
  byProject: {},
  setConn(projectId, info) {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: info } }))
  },
  getControlPath(projectId) {
    return get().byProject[projectId]?.controlPath
  },
  getHookEndpointPath(projectId) {
    return get().byProject[projectId]?.hookEndpointPath
  },
  getTmuxConfPath(projectId) {
    return get().byProject[projectId]?.tmuxConfPath
  },
  clear(projectId) {
    set((s) => {
      const next = { ...s.byProject }
      delete next[projectId]
      return { byProject: next }
    })
  }
}))
