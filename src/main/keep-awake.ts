// Keep-awake shell: binds the Electron-free tracker (core/keep-awake.ts) to Electron's
// powerSaveBlocker. `prevent-app-suspension` holds off IDLE sleep only — never display sleep,
// and a closed lid still sleeps the machine (no app can override that; user-facing copy says so).
// index.ts wires the seams (mirror edges, settings, SSH membership) next to the notch HUD block.

import { powerSaveBlocker } from 'electron'
import { createKeepAwake, type KeepAwakeTracker } from '../core/keep-awake'

export interface KeepAwakeDeps {
  /** Reads settings.keepAwakeWhileAgentsWork live. */
  enabled(): boolean
  /** True for nodes homed on an SSH project (workspaceStore.sshProjectIdForNode). */
  isRemoteNode(nodeId: string): boolean
  log?(msg: string): void
}

export function initKeepAwake(deps: KeepAwakeDeps): KeepAwakeTracker {
  // The one live assertion id. The core tracker already edge-triggers start/stop, so the id
  // checks here are pure paranoia — a double-start can never stack assertions, a stop without a
  // live id is a no-op, and `isStarted` guards against an id Electron already tore down.
  let blockerId: number | undefined
  return createKeepAwake({
    blocker: {
      start(): void {
        if (blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)) return
        blockerId = powerSaveBlocker.start('prevent-app-suspension')
      },
      stop(): void {
        if (blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)) {
          powerSaveBlocker.stop(blockerId)
        }
        blockerId = undefined
      }
    },
    ...deps
  })
}
