import type { MirrorFile, MirrorSettings } from '../../core/agent-status-mirror'
import { filterMirrorForNodes } from '../../core/agent-status-mirror'

/**
 * Pushes each connected SSH project's slice of the agent-status mirror onto its host, where the
 * mobile companion reads it (`~/.nodeterm/agent-status-<projectId>.json`). This file is the ONLY
 * status source that exists on an SSH host: hook events tunnel from the host to the desktop's
 * loopback hook server, so without this push a phone browsing the host directly sees live tmux
 * sessions but no agent states.
 *
 * Electron-free and dependency-injected so the throttle/heartbeat behavior is unit-testable;
 * index.ts wires the real mirror, workspace store and SshProjectManager in.
 */

/** Floor between two pushes to one project — a busy turn flushes the mirror every ~300 ms. */
export const STATUS_PUSH_THROTTLE_MS = 2_000
/**
 * The mirror only flushes on agent events, so a pushed file's `updatedAt` goes stale the moment
 * the desktop disconnects or quits — indistinguishable from an idle-but-connected desktop. The
 * heartbeat re-flushes (fresh `updatedAt`) so the phone can treat a stale file as "no data".
 */
export const STATUS_HEARTBEAT_MS = 60_000

interface Deps {
  /** Subscribe to mirror flushes (agent-status-mirror's onMirrorFlush). Returns unsubscribe. */
  onFlush: (cb: (doc: MirrorFile) => void) => () => void
  /** Trigger a mirror flush — the heartbeat rides the normal flush path so listeners fire. */
  flush: () => Promise<void>
  /** SSH project ids of the workspace index (pushAgentStatus no-ops for unconnected ones). */
  sshProjectIds: () => string[]
  /** Node ids belonging to one project — its slice of the mirror. */
  nodeIdsFor: (projectId: string) => ReadonlySet<string>
  /** Write one project's slice to its host. Best-effort (failures only stale the phone). */
  push: (projectId: string, json: string) => Promise<void>
  /** Per-host settings block for one project's slice (remote CLI caps + host-matched
   *  accounts — see index.ts wiring). undefined ⇒ the slice ships without settings. */
  settingsFor?: (projectId: string) => MirrorSettings | undefined
  throttleMs?: number
  /** 0 disables the heartbeat (tests drive flushes explicitly). */
  heartbeatMs?: number
}

export function initRemoteStatusPush(deps: Deps): { dispose: () => void } {
  const throttleMs = deps.throttleMs ?? STATUS_PUSH_THROTTLE_MS
  let latest: MirrorFile | null = null
  const timers = new Map<string, NodeJS.Timeout>()
  const dirty = new Set<string>()

  const pushProject = (id: string): void => {
    if (!latest) return
    const slice = filterMirrorForNodes(latest, deps.nodeIdsFor(id))
    let s: MirrorSettings | undefined
    try {
      s = deps.settingsFor?.(id)
    } catch {
      s = undefined // settings must never break a status push
    }
    if (s) slice.settings = s
    void deps.push(id, JSON.stringify(slice))
    const t = setTimeout(() => {
      timers.delete(id)
      // A flush landed inside the window → trailing push so the final state always ships.
      if (dirty.delete(id)) pushProject(id)
    }, throttleMs)
    t.unref?.()
    timers.set(id, t)
  }

  const off = deps.onFlush((doc) => {
    latest = doc
    for (const id of deps.sshProjectIds()) {
      if (timers.has(id)) dirty.add(id)
      else pushProject(id)
    }
  })

  const heartbeatMs = deps.heartbeatMs ?? STATUS_HEARTBEAT_MS
  const hb = heartbeatMs > 0 ? setInterval(() => void deps.flush(), heartbeatMs) : null
  hb?.unref?.()

  return {
    dispose: (): void => {
      off()
      if (hb) clearInterval(hb)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      dirty.clear()
    }
  }
}
