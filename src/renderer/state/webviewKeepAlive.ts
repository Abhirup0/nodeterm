/**
 * The webview keep-alive pool store — the stateful half of `lib/webviewKeepAlive.ts` (read that
 * file's header first; the ORDER of `entries` is load-bearing and every action here only ever
 * appends, removes, or replaces an entry in place).
 *
 * Renderer-local and transient by design: guests die with the window, so there is nothing to
 * persist. Canvas's project-load effect is the one writer of membership (`retireProject` /
 * `prune`); a GHOST surface writes its own navigation facts (`updateGhostData`) and reports its
 * guest's discard (`drop`).
 */
import { create } from 'zustand'
import type { CanvasNode } from './workspace'
import { activateInPool, retireIntoPool, type KeepAliveEntry } from '../lib/webviewKeepAlive'

interface WebviewKeepAliveState {
  entries: KeepAliveEntry[]
  /** Mark a project's entries active on the way IN — always BEFORE the outgoing project's
   *  `retireProject`, so the cap can never evict a page that is about to be revealed. */
  activateProject(projectId: string): void
  /** Move a project's webview nodes into the background: fresh snapshots, order slots kept,
   *  gone nodes pruned, cap enforced. Called on the way OUT of a project. */
  retireProject(projectId: string, outgoingNodes: readonly CanvasNode[]): void
  /** A ghost navigated (or re-titled) itself: keep the snapshot current so the ghost keeps
   *  rendering with the values its mounted surface reports, and so the switch-back overlay
   *  hands the live location to the returning project. */
  updateGhostData(nodeId: string, patch: { url?: string; title?: string }): void
  /** The entry is over — its guest was discarded, or its node/project is gone. */
  drop(nodeId: string): void
  /** Keep only entries whose project still exists (delete-project cleanup). */
  prune(liveProjectIds: ReadonlySet<string>): void
}

export const useWebviewKeepAlive = create<WebviewKeepAliveState>((set, get) => ({
  entries: [],
  activateProject(projectId) {
    const next = activateInPool(get().entries, projectId)
    if (next.some((e, i) => e !== get().entries[i])) set({ entries: next })
  },
  retireProject(projectId, outgoingNodes) {
    set({ entries: retireIntoPool(get().entries, projectId, outgoingNodes, Date.now()) })
  },
  updateGhostData(nodeId, patch) {
    set({
      entries: get().entries.map((e) =>
        e.nodeId === nodeId ? { ...e, node: { ...e.node, data: { ...e.node.data, ...patch } } } : e
      )
    })
  },
  drop(nodeId) {
    if (!get().entries.some((e) => e.nodeId === nodeId)) return
    set({ entries: get().entries.filter((e) => e.nodeId !== nodeId) })
  },
  prune(liveProjectIds) {
    if (get().entries.every((e) => liveProjectIds.has(e.projectId))) return
    set({ entries: get().entries.filter((e) => liveProjectIds.has(e.projectId)) })
  }
}))
