// Shared source of the host renderer's latest active-project canvas snapshot.
//
// The renderer pushes its serialized canvas over `remoteHostCanvasState`; both the interactive
// remote host (host-service) and the standing phone host (standing-host) mirror that same canvas
// to their respective clients. Centralizing the single IPC listener here (installed once) lets
// both host sessions read the current snapshot and subscribe to updates without duplicating the
// listener or fighting over `latestCanvas`.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CanvasState } from '../../shared/types'

type Sub = (state: CanvasState) => void

const subs = new Set<Sub>()
let latest: CanvasState | null = null
let installed = false

/** Install the single `remoteHostCanvasState` IPC listener. Idempotent — safe to call from each host. */
export function initHostCanvasHub(): void {
  if (installed) return
  installed = true
  ipcMain.on(IPC.remoteHostCanvasState, (_e, state: CanvasState) => {
    latest = state
    for (const s of subs) s(state)
  })
}

/** The most recent canvas snapshot the renderer pushed, or null before the first push. */
export function currentCanvas(): CanvasState | null {
  return latest
}

/** Subscribe to canvas updates. Returns an unsubscribe function. */
export function subscribeCanvas(cb: Sub): () => void {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}
