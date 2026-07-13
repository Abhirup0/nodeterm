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
  /** The connection's resolved remote `$HOME`. Used to build an ABSOLUTE remote
   *  `CLAUDE_CONFIG_DIR` for a managed remote account. Optional: absent if it couldn't resolve. */
  remoteHome?: string
  /** Does the REMOTE host's claude CLI accept `--permission-mode auto` (>= 2.1.71)? The local
   *  CLI's answer says nothing about the remote one, so the host is probed on its own — AFTER
   *  connect (the probe's login shell is slow and must not delay the project's terminals), so this
   *  is usually absent here and arrives later on a `connected` status event. Absent/false ⇒ this
   *  project's Claude nodes launch with the bare command (no `auto` flag). */
  claudeAutoPermissionMode?: boolean
  /** The probed remote `claude --version` output (`null` = probe ran, claude not found). Feeds
   *  the tab menu's Auto hint; only present on a reused (already probed) connection. */
  remoteClaudeVersion?: string | null
}

/** What the remote probe has said so far — the tab menu's Auto hint reads differently for "not
 *  probed yet" vs "probed and unsupported". The LAUNCH gate stays `supportsAutoPermissionMode`
 *  (boolean, conservative: unknown = no flag). */
export type SshAutoPermAnswer = 'yes' | 'no' | 'unknown'

/**
 * Transient map of SSH project id → its live connection info (ControlMaster `controlPath` +
 * optional remote `hookEndpointPath`) returned by `sshProject.connect`. Not persisted: it's
 * re-established on every launch by Canvas's active-project effect. A remote terminal node reads
 * its project's entry here to pass `sshRemote` into `transport.create`, so the PTY runs over the
 * project's master and (when present) the remote hook env is injected.
 */
interface SshConnState {
  byProject: Record<string, SshConnInfo>
  /** project id → "the remote CLI accepts `--permission-mode auto`". Kept OUTSIDE `byProject`
   *  because the remote probe runs after connect and can land before OR after the connect promise
   *  writes the entry — a separate map makes the two orders equivalent. */
  autoPermByProject: Record<string, boolean>
  /** project id → the probed remote `claude --version` output (`null` = claude not found). Kept
   *  beside `autoPermByProject` (same lifecycle) so the tab-menu hint can name the version. */
  remoteClaudeVersionByProject: Record<string, string | null>
  setConn(projectId: string, info: SshConnInfo): void
  /** Record the remote CLI probe's answer (pushed on a `connected` status event once it lands).
   *  `version` rides the same event; undefined leaves the cached version untouched. */
  setClaudeAutoPermissionMode(projectId: string, supported: boolean, version?: string | null): void
  getControlPath(projectId: string): string | undefined
  getHookEndpointPath(projectId: string): string | undefined
  getTmuxConfPath(projectId: string): string | undefined
  getRemoteHome(projectId: string): string | undefined
  /** True ONLY when the remote CLI was probed and is known to accept `--permission-mode auto`.
   *  Not connected / never probed / older CLI all answer false (conservative — omit the flag). */
  supportsAutoPermissionMode(projectId: string): boolean
  /** Tri-state view of the probe for UI hints: 'unknown' until an answer lands (or after
   *  invalidation), then 'yes'/'no'. The launch gate above stays boolean. */
  autoPermAnswer(projectId: string): SshAutoPermAnswer
  /** The probed remote version (`null` = probed, claude not found; undefined = never probed). */
  getRemoteClaudeVersion(projectId: string): string | null | undefined
  /** Drop the cached probe answer WITHOUT touching the rest of the conn info (unlike `clear()`,
   *  which is for project deletion). Call this on a `disconnected` / `reconnecting` status: if the
   *  project's SSH server gets repointed to a different host, the previous host's cached `true`
   *  must not survive to be served against the new (possibly older) remote CLI — the fail-open
   *  design means "unknown" should win until the next probe lands, never a stale "yes". */
  invalidateAutoPermissionMode(projectId: string): void
  clear(projectId: string): void
}

export const useSshConn = create<SshConnState>((set, get) => ({
  byProject: {},
  autoPermByProject: {},
  remoteClaudeVersionByProject: {},
  setConn(projectId, info) {
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: info },
      // A reused (already probed) connection returns the answer with the connect result.
      autoPermByProject:
        info.claudeAutoPermissionMode === undefined
          ? s.autoPermByProject
          : { ...s.autoPermByProject, [projectId]: info.claudeAutoPermissionMode },
      remoteClaudeVersionByProject:
        info.remoteClaudeVersion === undefined
          ? s.remoteClaudeVersionByProject
          : { ...s.remoteClaudeVersionByProject, [projectId]: info.remoteClaudeVersion }
    }))
  },
  setClaudeAutoPermissionMode(projectId, supported, version) {
    set((s) => ({
      autoPermByProject: { ...s.autoPermByProject, [projectId]: supported },
      remoteClaudeVersionByProject:
        version === undefined
          ? s.remoteClaudeVersionByProject
          : { ...s.remoteClaudeVersionByProject, [projectId]: version }
    }))
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
  getRemoteHome(projectId) {
    return get().byProject[projectId]?.remoteHome
  },
  supportsAutoPermissionMode(projectId) {
    return get().autoPermByProject[projectId] === true
  },
  autoPermAnswer(projectId) {
    const v = get().autoPermByProject[projectId]
    return v === undefined ? 'unknown' : v ? 'yes' : 'no'
  },
  getRemoteClaudeVersion(projectId) {
    return get().remoteClaudeVersionByProject[projectId]
  },
  invalidateAutoPermissionMode(projectId) {
    set((s) => {
      if (!(projectId in s.autoPermByProject) && !(projectId in s.remoteClaudeVersionByProject)) {
        return s
      }
      const next = { ...s.autoPermByProject }
      delete next[projectId]
      const nextVersion = { ...s.remoteClaudeVersionByProject }
      delete nextVersion[projectId]
      return { autoPermByProject: next, remoteClaudeVersionByProject: nextVersion }
    })
  },
  clear(projectId) {
    set((s) => {
      const next = { ...s.byProject }
      delete next[projectId]
      const nextAuto = { ...s.autoPermByProject }
      delete nextAuto[projectId]
      const nextVersion = { ...s.remoteClaudeVersionByProject }
      delete nextVersion[projectId]
      return { byProject: next, autoPermByProject: nextAuto, remoteClaudeVersionByProject: nextVersion }
    })
  }
}))
