// One long-lived Claude Agent SDK query per chat node (streaming input mode). The renderer
// talks to this over the narrow chat:* IPC surface; SDK messages are reduced by
// chat-events.ts and pushed on chat:event:<nodeId>. Continuity is resume-based: the
// process dies with the app; the node's persisted chatSessionId resumes the transcript.
import { IPC } from '../shared/ipc'
import type { ChatEvent, ChatImageAttachment, ChatPermissionDecision } from '../shared/types'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { sdkMessageToEvents } from './chat-events'
import { ChatInputQueue, createPushIterable } from './chat-queue'
import { resolveTranscriptPath } from './transcript-reader'
import { claudeConfigDirFor } from './claude-config-dir'
import { recordAgentEvent } from './agent-status-mirror'
import { AUTH_ENV_STRIP } from './claude-accounts-core'

interface PendingPermission { resolve: (d: ChatPermissionDecision) => void }

interface ChatSession {
  nodeId: string
  cwd?: string
  sessionId?: string
  // Managed account this chat runs on (its CLAUDE_CONFIG_DIR); undefined = default login.
  accountId?: string
  working: boolean
  input: ReturnType<typeof createPushIterable<unknown>>
  queue: ChatInputQueue
  pending: Map<string, PendingPermission>
  allowedForSession: Set<string>
  interrupt?: () => Promise<void>
  // Set by interrupt() before it fires the SDK interrupt, so the resulting turn-done is treated
  // as a user Stop: it must NOT auto-flush the queue and its done status carries interrupted:true
  // (so Canvas skips the completion notification). Cleared when that turn-done is handled.
  interruptedByUser: boolean
  disposed: boolean
}

type SendToMain = (channel: string, payload: unknown) => void

// Minimal structural view of the send target. The codebase resolves the live window at send
// time via getMainWindow() (returns MainWindowLike, never a raw BrowserWindow — capturing one
// leaves a dead webContents after a macOS close→dock-reopen), so we accept anything that can
// send on its webContents rather than the full BrowserWindow type.
type WindowLike = { webContents: { send(channel: string, ...args: unknown[]): void } }

export class ChatDriver {
  private sessions = new Map<string, ChatSession>()
  constructor(
    private getWindow: () => WindowLike | null,
    private sendToMain: SendToMain
  ) {}

  private emit(nodeId: string, event: ChatEvent): void {
    this.getWindow()?.webContents.send(IPC.chatEvent(nodeId), event)
  }

  private status(
    s: ChatSession,
    state: 'working' | 'blocked' | 'done',
    newTurn = false,
    interrupted = false
  ): void {
    const ev: NormalizedAgentEvent = {
      nodeId: s.nodeId, agentId: 'claude', kind: 'state', state, newTurn,
      sessionId: s.sessionId, ...(interrupted ? { interrupted: true } : {})
    }
    this.sendToMain(IPC.agentStatus, ev)
    recordAgentEvent(ev)
  }

  async ensure(
    nodeId: string,
    opts: { cwd?: string; sessionId?: string; fork?: boolean; accountId?: string }
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.sessions.has(nodeId)) return { ok: true }
    // Resume validation: a sessionId whose transcript is gone would silently start a
    // fresh session with mismatched history — surface it instead. Look in the account dir.
    let resume = opts.sessionId
    if (resume && !(await resolveTranscriptPath(resume, opts.accountId))) {
      this.emit(nodeId, { kind: 'error', message: 'Previous session transcript not found — starting fresh.' })
      resume = undefined
    }
    const s: ChatSession = {
      nodeId, cwd: opts.cwd, sessionId: resume, accountId: opts.accountId, working: false,
      input: createPushIterable<unknown>(), queue: new ChatInputQueue(),
      pending: new Map(), allowedForSession: new Set(),
      interruptedByUser: false, disposed: false
    }
    this.sessions.set(nodeId, s)
    void this.run(s, resume, opts.fork === true).catch((err) => {
      this.emit(nodeId, { kind: 'error', message: String(err?.message ?? err), fatal: true })
      // Tear down like dispose(): resolve/clear any pending permission cards and end input, so a
      // fatal crash doesn't leave a stale permission prompt or "working" badge before Reconnect.
      this.teardown(s)
      this.sessions.delete(nodeId)
    })
    return { ok: true }
  }

  private async run(s: ChatSession, resume: string | undefined, fork: boolean): Promise<void> {
    // Task-1 spike result: the SDK runs under Electron main with no env/executable
    // overrides (ELECTRON_RUN_AS_NODE inheritance is harmless), so no special spawn handling.
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const q = query({
      prompt: s.input.iterable as AsyncIterable<never>,
      options: {
        cwd: s.cwd,
        ...(resume ? { resume } : {}),
        ...(fork ? { forkSession: true } : {}),
        // Managed account: the SDK's claude subprocess inherits this env, so credentials
        // AND the transcript live in the account dir. AUTH_ENV_STRIP mirrors the PTY path.
        // Account-less sessions get no env option at all (inherit the default login untouched).
        ...(s.accountId
          ? {
              env: (() => {
                const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDirFor(s.accountId) }
                for (const k of AUTH_ENV_STRIP) delete env[k]
                return env as Record<string, string>
              })()
            }
          : {}),
        includePartialMessages: true,
        permissionMode: 'default',
        canUseTool: async (toolName: string, input: Record<string, unknown>, { toolUseID }: { toolUseID: string }) => {
          if (s.allowedForSession.has(toolName)) return { behavior: 'allow' as const, updatedInput: input }
          const requestId = toolUseID
          this.emit(s.nodeId, { kind: 'permission', requestId, toolName, input })
          this.status(s, 'blocked')
          const decision = await new Promise<ChatPermissionDecision>((resolve) => {
            s.pending.set(requestId, { resolve })
          })
          s.pending.delete(requestId)
          this.emit(s.nodeId, { kind: 'permission-done', requestId })
          this.status(s, 'working')
          if (decision.behavior === 'allow') {
            if (decision.alwaysSession) s.allowedForSession.add(toolName)
            return { behavior: 'allow' as const, updatedInput: input }
          }
          return { behavior: 'deny' as const, message: 'User denied in nodeterm chat.' }
        }
      }
    })
    s.interrupt = () => q.interrupt()
    for await (const msg of q) {
      if (s.disposed) break
      for (const event of sdkMessageToEvents(msg as never)) {
        if (event.kind === 'session') s.sessionId = event.sessionId
        this.emit(s.nodeId, event)
        if (event.kind === 'turn-done') {
          s.working = false
          // A user Stop (interrupt) ends the turn too — but the queue must stay put (items are
          // individually deletable) and Canvas must skip the "finished" notification.
          const interrupted = s.interruptedByUser
          s.interruptedByUser = false
          this.status(s, 'done', false, interrupted)
          if (!interrupted) this.flushQueue(s)
        }
      }
    }
  }

  private pushUser(s: ChatSession, text: string, images?: ChatImageAttachment[]): void {
    const content: unknown = images?.length
      ? [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
          { type: 'text', text }
        ]
      : text
    s.input.push({ type: 'user', message: { role: 'user', content } })
    s.working = true
    this.status(s, 'working', true)
  }

  private flushQueue(s: ChatSession): void {
    const next = s.queue.takeNext()
    this.emit(s.nodeId, { kind: 'queue', items: s.queue.items() })
    if (next) this.pushUser(s, next.text)
  }

  send(nodeId: string, text: string, images?: ChatImageAttachment[]): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    if (s.working) {
      s.queue.add(text) // images only send immediately in v1; queued items are text
      this.emit(nodeId, { kind: 'queue', items: s.queue.items() })
      return
    }
    this.pushUser(s, text, images)
  }

  interrupt(nodeId: string): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    // Flag the turn as user-stopped BEFORE firing the SDK interrupt, so the turn-done it
    // triggers is handled as a Stop (no auto-flush, interrupted status).
    s.interruptedByUser = true
    void s.interrupt?.().catch(() => {})
  }

  permissionReply(nodeId: string, requestId: string, decision: ChatPermissionDecision): void {
    this.sessions.get(nodeId)?.pending.get(requestId)?.resolve(decision)
  }

  removeQueued(nodeId: string, queueId: string): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    s.queue.remove(queueId)
    this.emit(nodeId, { kind: 'queue', items: s.queue.items() })
  }

  // Shared teardown for both dispose() and the fatal catch path: deny + clear every pending
  // permission (resolving the awaiting canUseTool promise AND clearing its renderer card via
  // permission-done), then end the input stream so the SDK query settles.
  private teardown(s: ChatSession): void {
    for (const [requestId, p] of s.pending) {
      p.resolve({ behavior: 'deny' })
      this.emit(s.nodeId, { kind: 'permission-done', requestId })
    }
    s.pending.clear()
    s.input.end()
  }

  dispose(nodeId: string): void {
    const s = this.sessions.get(nodeId)
    if (!s) return
    s.disposed = true
    this.teardown(s)
    void s.interrupt?.().catch(() => {})
    this.sessions.delete(nodeId)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }
}
