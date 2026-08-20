// Tiny, HUD-only preload (docs/notch-hud.md). The Notch HUD is a separate BrowserWindow with a
// minimal surface — it does not need the full `window.nodeTerminal` API, so it gets its own bridge
// exposing exactly the HUD channels. contextIsolation stays on; no node integration.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

export interface HudSubagentRow {
  id: string
  label?: string
  state: 'working' | 'done'
}
export interface HudRow {
  nodeId: string
  agentId?: string
  title: string
  model?: string
  state: 'working' | 'needsYou' | 'done' | 'idle'
  prompt?: string
  activity?: string
  contextPercent?: number
  subagents: HudSubagentRow[]
  /** A finished turn the user has not looked at yet (the sessions sidebar's `unread` mark) — the
   *  row's sort tier and its "Unread" badge. */
  unread: boolean
  updatedAt: number
}
export interface HudPush {
  rows: HudRow[]
  /** Notch/menu-bar strip height in px (the capsule's fused top zone; content sits below it). */
  bar: number
  /** Primary-display width in px. */
  width: number
  /** Assumed physical notch width in px — the capsule's collapsed (fused) width. */
  notchWidth: number
  /** Notch horizontal center in px (= width / 2) — where the capsule anchors. */
  notchCenterX: number
  /** True when a physical notch is present (fuse to it); false = draw a standalone floating pill. */
  hasNotch: boolean
  /** Expand the panel on hover (settings.notchHoverExpand); false = click-only. */
  hoverExpand: boolean
  /** settings.usagePercentMode — how a row's context percentage renders ("42% used" / "58% left"). */
  percentMode: 'used' | 'remaining' | 'tokens'
}

export interface HudApi {
  /** main → hud: subscribe to row/geometry pushes. Returns an unsubscribe. */
  onRows(cb: (push: HudPush) => void): () => void
  /** hud → main: toggle window click-through (true = pass clicks through). */
  setIgnoreMouse(ignore: boolean): void
  /** hud → main: a row was clicked — focus that node in nodeterm. */
  focusNode(nodeId: string): void
  /** hud → main: the panel expanded (true) / collapsed (false). */
  setExpanded(expanded: boolean): void
  /** hud → main: remove this row from the HUD (a session stuck in `working`). */
  dismiss(nodeId: string): void
}

const api: HudApi = {
  onRows(cb) {
    const handler = (_e: unknown, push: HudPush): void => cb(push)
    ipcRenderer.on(IPC.hudRows, handler)
    return () => ipcRenderer.removeListener(IPC.hudRows, handler)
  },
  setIgnoreMouse: (ignore) => ipcRenderer.send(IPC.hudSetIgnoreMouse, ignore),
  focusNode: (nodeId) => ipcRenderer.send(IPC.hudFocusNode, nodeId),
  setExpanded: (expanded) => ipcRenderer.send(IPC.hudExpanded, expanded),
  dismiss: (nodeId) => ipcRenderer.send(IPC.hudDismiss, nodeId)
}

contextBridge.exposeInMainWorld('hud', api)
