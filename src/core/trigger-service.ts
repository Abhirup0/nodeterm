/**
 * The trigger node's whole host-side machine, composed ONCE (issue #493, phase 3): the
 * machine-local arm store + the scheduler + the delivery (with its deliver-on-idle queue) + the
 * idle signal, wired together here so BOTH shells boot the identical thing with a one-call
 * `startTriggerService(...)`. This is the duplicated-wiring lesson applied preemptively — phase 2
 * had each shell assemble the pieces inline, and every extra piece phase 3 adds is one more line
 * for the two copies to disagree about.
 *
 * The idle signal is the core mirror's own `done` edge (`onNodeStateChange`), which both shells
 * already feed through their raw hook listeners — so the queue flush needs NO per-shell listener
 * branch, and there is nothing here for the hook-parity discipline to chase.
 */

import { mirrorEntry, onNodeStateChange } from './agent-status-mirror'
import { TriggerArmStore } from './trigger-arm-store'
import { createTriggerDelivery, type TriggerDeliveryDeps } from './trigger-delivery'
import {
  createTriggerScheduler,
  triggerRowsFromCanvases,
  type TriggerScheduler
} from './trigger-scheduler'
import { sanitizeTriggerSpec } from '../shared/trigger'
import type { CanvasNodeState } from '../shared/types'

export interface TriggerServiceDeps {
  /** Where the arm store persists (`app.getPath('userData')` / `config.dataDir`). */
  userDataDir: string
  /** `WorkspaceStore.persistedCanvases` — the trigger list's raw material. */
  listCanvases(): Array<{ id: string; nodes: CanvasNodeState[] }>
  /** `WorkspaceStore.getNode` — target resolution + the flush-time current-spec re-read. */
  getNode(nodeId: string): CanvasNodeState | undefined
  /** `PtyManager.sendText` / `PtyManager.paneCommand`. */
  sendText(nodeId: string, text: string): Promise<boolean>
  paneCommand(nodeId: string): Promise<string | null>
  /** Test seams; production passes none. */
  now?(): number
  schedulerIntervalMs?: number
  schedule?: TriggerDeliveryDeps['schedule']
}

export interface TriggerService {
  scheduler: TriggerScheduler
  armStore: TriggerArmStore
  stop(): void
}

export function startTriggerService(deps: TriggerServiceDeps): TriggerService {
  const armStore = new TriggerArmStore(deps.userDataDir)
  const isArmed = (projectId: string, nodeId: string, spec: Parameters<TriggerArmStore['isArmed']>[2]) =>
    armStore.isArmed(projectId, nodeId, spec)

  const delivery = createTriggerDelivery({
    sendText: deps.sendText,
    paneCommand: deps.paneCommand,
    agentState: (nodeId) => mirrorEntry(nodeId),
    targetNode: (nodeId) => deps.getNode(nodeId),
    // The trigger's OWN node, freshly resolved — what the queue's flush re-validates against.
    // getNode scans by node id; the projectId key is already bound into the arm record.
    currentSpec: (_projectId, nodeId) => {
      const node = deps.getNode(nodeId)
      if (!node || node.kind !== 'trigger') return undefined
      return sanitizeTriggerSpec(node.trigger)
    },
    isArmed,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {})
  })

  const scheduler = createTriggerScheduler({
    listTriggers: () => triggerRowsFromCanvases(deps.listCanvases()),
    isArmed,
    fire: (row) => delivery.fire(row),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedulerIntervalMs ? { intervalMs: deps.schedulerIntervalMs } : {})
  })
  delivery.setRunSink(scheduler.recordExternalRun)

  // The queue's flush trigger: a target finished a turn, so it is idle NOW — the same edge
  // messaging flushes on, read from core instead of each shell's listener.
  const unsubscribe = onNodeStateChange((change) => {
    if (change.state === 'done') void delivery.onTargetIdle(change.nodeId)
  })

  void armStore.load().finally(() => scheduler.start())

  return {
    scheduler,
    armStore,
    stop() {
      unsubscribe()
      scheduler.stop()
    }
  }
}
