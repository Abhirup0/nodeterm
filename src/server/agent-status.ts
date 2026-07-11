// Server-side agent-status wiring: a faithful transcription of the LOCAL (non-SSH) branch of
// the hook-wiring block in `src/main/index.ts`, with the Electron seams swapped for the
// headless server platform. Installs the hook server's normalized + raw listeners so agent
// status badges, subagent live transcripts, and the context-window meter all reach the
// browser over `platform.broadcast`. The SSH branch (remote tails / RemoteFile) is dropped —
// the server has no SSH-project manager — so the raw listener falls straight through to the
// local logic.
//
// This module must import nothing from electron or `../main` (see no-electron.test.ts).
import { resolve } from 'path'
import { homedir } from 'os'
import { hookServer } from '../core/agents/hook-server'
import { recordAgentEvent } from '../core/agent-status-mirror'
import { createSubagentTail, type SubagentTail } from '../core/subagent-tail'
import { createContextTail, type ContextTail, type TaskNotification } from '../core/context-tail'
import { setNodeTranscript } from '../core/context-link'
import { isSafeLocalTranscriptPath } from '../core/claude-accounts-core'
import { isAsyncSubagentLaunch, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { IPC } from '../shared/ipc'
import type { ServerPlatform } from './platform-server'

/** The narrow surface of the hook server this module needs — injectable for tests. */
export interface HookLike {
  setListener(cb: (e: NormalizedAgentEvent) => void): void
  setRawListener(cb: (agentId: string, nodeId: string, payload: Record<string, unknown>) => void): void
}

export interface WireAgentStatusOptions {
  hooks?: HookLike
  subagentTail?: SubagentTail
  contextTail?: ContextTail
}

/**
 * Install the hook listeners that drive agent-status badges, subagent viz, and the context
 * meter, routing every push over `platform.broadcast`. Injectable seams (`opts`) let tests
 * fire events without binding a real port or touching the filesystem; production defaults use
 * the real `hookServer` singleton and real tails.
 *
 * Does NOT call `hookServer.start()` — the boot step owns starting the server.
 */
export function wireAgentStatus(platform: ServerPlatform, opts: WireAgentStatusOptions = {}): void {
  const hooks = opts.hooks ?? hookServer
  // nodeId → claude sessionId
  const nodeContextSession = new Map<string, string>()
  // nodeId → active subagent tool_use_ids
  const nodeSubagents = new Map<string, Set<string>>()

  const subagentTail =
    opts.subagentTail ??
    createSubagentTail(({ toolUseId, chunk }) => {
      platform.broadcast(IPC.agentSubagentActivity, { toolUseId, chunk })
    })

  // Async subagents (Claude's default) end via a <task-notification> queued into the PARENT
  // transcript — their PostToolUse is only a launch ack. The context tail reads that transcript,
  // surfaces the notification here, and we emit the synthetic subagent-end the hooks never send,
  // then release the subagent transcript tail.
  const onTaskNotification = (sessionId: string, n: TaskNotification): void => {
    let nodeId: string | undefined
    for (const [nid, sid] of nodeContextSession) if (sid === sessionId) nodeId = nid
    if (!nodeId) return
    const taskDoneEvent = {
      nodeId,
      agentId: 'claude',
      sessionId,
      kind: 'subagent-end',
      toolUseId: n.toolUseId,
      result: n.result
    } satisfies NormalizedAgentEvent
    platform.broadcast(IPC.agentStatus, taskDoneEvent)
    recordAgentEvent(taskDoneEvent)
    subagentTail.finish(n.toolUseId)
    nodeSubagents.get(nodeId)?.delete(n.toolUseId)
  }

  const contextTail =
    opts.contextTail ??
    createContextTail(
      (payload) => {
        platform.broadcast(IPC.contextUpdate, payload)
      },
      { onTaskNotification }
    )

  hooks.setListener((e) => {
    platform.broadcast(IPC.agentStatus, e)
    recordAgentEvent(e)
  })

  // Security: hook POSTs can be forged, so a forged POST could set transcript_path to an
  // arbitrary local path (e.g. ~/.ssh/id_rsa) and have the app read it. The tails read the
  // local filesystem; legitimate local transcripts live under the system default
  // `~/.claude/projects` OR a managed account's `{userData}/claude-accounts/<id>/projects`
  // (id-validated so a forged POST can't traverse out — see isSafeLocalTranscriptPath). Jail
  // transcript_path to those roots and skip the read otherwise.
  const safeTranscriptPath = (tp: string | undefined): string | undefined => {
    if (!tp) return undefined
    const abs = resolve(tp)
    return isSafeLocalTranscriptPath(abs, homedir(), platform.userDataDir) ? abs : undefined
  }

  const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
  hooks.setRawListener((agentId, nodeId, payload) => {
    if (agentId !== 'claude') return
    const p = payload as {
      hook_event_name?: string
      session_id?: string
      transcript_path?: string
      tool_name?: string
      tool_use_id?: string
      tool_response?: { status?: string; isAsync?: boolean }
    }
    // An async subagent's PostToolUse is only the launch ack — keep tailing its transcript;
    // the real end (task-notification via the context tail) releases it.
    const asyncLaunch = p.hook_event_name === 'PostToolUse' && isAsyncSubagentLaunch(p.tool_response)
    const transcriptPath = safeTranscriptPath(p.transcript_path)
    // Context-window meter: tail the session transcript (any event carrying both fields).
    if (p.session_id && transcriptPath) contextTail.track(p.session_id, transcriptPath)
    if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
    if (nodeId && p.session_id && transcriptPath) setNodeTranscript(nodeId, p.session_id, transcriptPath)
    if (p.hook_event_name === 'SessionEnd' && p.session_id) contextTail.untrack(p.session_id)
    // Subagent live transcript: track on PreToolUse / finish on PostToolUse for subagent tools.
    if (p.tool_use_id && p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) {
      if (p.hook_event_name === 'PreToolUse') {
        subagentTail.track(p.tool_use_id, transcriptPath)
        if (nodeId) {
          const set = nodeSubagents.get(nodeId) ?? new Set<string>()
          set.add(p.tool_use_id)
          nodeSubagents.set(nodeId, set)
        }
      } else if (p.hook_event_name === 'PostToolUse' && !asyncLaunch) {
        subagentTail.finish(p.tool_use_id)
        if (nodeId) nodeSubagents.get(nodeId)?.delete(p.tool_use_id)
      }
    }
    // Session over → release any still-tracked async subagent tails for this node (their
    // task-notifications will never arrive once the session is gone).
    if (p.hook_event_name === 'SessionEnd' && nodeId) {
      for (const toolUseId of nodeSubagents.get(nodeId) ?? []) subagentTail.finish(toolUseId)
      nodeSubagents.delete(nodeId)
    }
  })

  // Node close → tear down its tails and clear the maps (server parity with desktop
  // `src/main/index.ts`'s local `ipcMain.on(IPC.ptyDestroy, …)` branch; the remote/SSH lines are
  // dropped — the server has no SSH-project manager). Coexists with PtyManager's own ptyDestroy
  // listener via the multi-listener `on`: that one kills the tmux session, this untracks the
  // tails. Untracking a non-tracked session/subagent is a no-op, so re-destroy is harmless.
  platform.on(IPC.ptyDestroy, (nodeId: string) => {
    const sessionId = nodeContextSession.get(nodeId)
    if (sessionId) {
      contextTail.untrack(sessionId)
      nodeContextSession.delete(nodeId)
    }
    const subs = nodeSubagents.get(nodeId)
    if (subs) {
      for (const toolUseId of subs) subagentTail.finish(toolUseId)
      nodeSubagents.delete(nodeId)
    }
  })
}
