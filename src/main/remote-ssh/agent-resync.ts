// Repair agent status after an SSH project's reverse hook tunnel comes back.
//
// Hook events are fire-and-forget POSTs through that tunnel, and nothing on the host queues them:
// an agent that finishes while the master is down loses its `done` for good. The node then sits at
// `working` on every surface until `sweepStaleWorking` guesses from silence 20 minutes later — so
// the user cannot tell "finished" from "waiting on a permission prompt" from "the CLI died".
//
// So when the tunnel is verified again, ask the host what is actually true. This module is the
// orchestration only: the judgement is the pure `decideNode` (core/remote-ssh/agent-resync-decide),
// and every side effect is an injected dep.

import { decideNode } from '../../core/remote-ssh/agent-resync-decide'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { AgentId } from '@shared/agents/config'
import type { SshConnection } from '@shared/ssh'

export interface AgentResyncDeps {
  /** Nodes the mirror still believes are working (agent-status-mirror.workingNodes). */
  workingNodes: () => { nodeId: string; agentId?: string; sessionId?: string }[]
  /** The node's live remote handle, or undefined for a local session (PtyManager.sshRemoteForNode). */
  remoteFor: (nodeId: string) => { controlPath: string; conn: SshConnection } | undefined
  /** `#{pane_current_command}` for the node's tmux session (PtyManager.paneCommand). */
  paneCommand: (nodeId: string) => Promise<string | null>
  /** A bounded tail of the node's transcript on the host, or null when it can't be read. */
  readTranscriptTail: (nodeId: string, sessionId: string) => Promise<string | null>
  /** The single normalized-event funnel (main/index.ts emitAgentStatus). */
  emit: (e: NormalizedAgentEvent) => void
}

/**
 * Resync every working node that belongs to the project owning `controlPath`.
 *
 * Only nodes the mirror calls `working` are considered: that is the one state a lost hook event can
 * strand. The opposite error — a node we believe idle that is really working — corrects itself
 * within seconds, because hook events fire continuously through a turn.
 *
 * Returns the node ids declared ended (for logging/tests). Never throws: a probe that fails is
 * `undecided`, and undecided changes nothing.
 */
export async function resyncProjectAgents(
  controlPath: string,
  deps: AgentResyncDeps
): Promise<string[]> {
  const ended: string[] = []
  let working: { nodeId: string; agentId?: string; sessionId?: string }[]
  try {
    working = deps.workingNodes()
  } catch {
    return ended // no list ⇒ nothing to repair, and still not a rejection for the reconnect path
  }

  for (const node of working) {
    // One node's failure is `undecided` for THAT node — never a project-wide abort. `emit` is the
    // real risk here: it fans out into the mirror reducer, the inbox, a disk write and the HUD, and
    // a throw there would otherwise cost every later node its rescue and reject into the reconnect.
    try {
      // A synthetic event carries an agentId by contract; without one we cannot emit a well-formed
      // event, and inventing an agent would misattribute the node on every surface.
      if (!node.agentId) continue
      if (deps.remoteFor(node.nodeId)?.controlPath !== controlPath) continue

      const pane = await probe(() => deps.paneCommand(node.nodeId))
      let tail: string | null = null
      // Only pay for the transcript read when the pane could not answer on its own.
      if (!isDecisivePane(pane) && node.sessionId) {
        const sessionId = node.sessionId
        tail = await probe(() => deps.readTranscriptTail(node.nodeId, sessionId))
      }

      if (decideNode(pane, tail) !== 'ended') continue

      // `idle: true` is the existing rescue-signal flag: a done carrying it may only move a node
      // that is still `working`, so a node parked on a permission prompt can never be cleared here.
      deps.emit({
        nodeId: node.nodeId,
        agentId: node.agentId as AgentId,
        kind: 'state',
        state: 'done',
        idle: true,
        ...(node.sessionId ? { sessionId: node.sessionId } : {})
      })
      ended.push(node.nodeId)
    } catch {
      continue
    }
  }
  return ended
}

/**
 * Run one probe, degrading any failure to `null` — which `decideNode` reads as no evidence.
 *
 * The call itself is inside the try, not just the promise: a dep that throws SYNCHRONOUSLY never
 * returns a promise to `.catch`, so it would escape to the loop's guard and cost the node its OTHER
 * probe leg. One failed probe must only silence that probe.
 */
async function probe(run: () => Promise<string | null>): Promise<string | null> {
  try {
    return await run()
  } catch {
    return null
  }
}

/** Did the pane probe settle it by itself? Mirrors decideFromPane's 'ended' branch. */
function isDecisivePane(pane: string | null): boolean {
  return decideNode(pane, null) === 'ended'
}
