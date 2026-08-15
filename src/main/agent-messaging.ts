/**
 * The desktop's agent-messaging service — the ONE caller of `deliverAgentMessage` (PR #207).
 *
 * Canvas.tsx's dispatch for `send`/`reply` is deliberately thin: it validates the arguments,
 * checks the SOURCE is a control-capable agent, and forwards `{verb, sourceNodeId, targetNodeId,
 * body}` here over IPC. Everything that decides whether and how the message lands runs in THIS
 * process, against main's own stores — the scope resolution, the per-project switch, flow control,
 * the pane probes, the envelope, the receipt, the trace — so nothing that ends up inside the
 * envelope or inside an authorization decision is renderer-supplied beyond the two node ids and
 * the body. `agent-messaging.test.ts` runs the whole service; `agent-message.test.ts` and
 * `agent-message.realtty.test.ts` pin the primitive underneath it.
 *
 * ── THREE SURFACES ──────────────────────────────────────────────────────────────────────────────
 * - **Desktop (Electron):** wired in `src/main/index.ts` — the only surface with the verbs.
 * - **Server Edition:** never wired; `/control/send` answers `control-unsupported-on-this-edition`
 *   (`src/server/control-unsupported.ts`) for a verified caller and the messaging refusal for an
 *   unverified one. Everything this file imports from `src/core` still ships on both shells.
 * - **Mobile (phone):** never a sender (it drives canvas control over relay→IPC, not `/control/*`);
 *   a phone-spawned node is a valid TARGET and resolves like any other store node.
 */
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { binariesFor, type PaneOwner } from '../shared/agents/pane-owner-predicate'
import type { BoardLogEntry } from '../shared/types'
import type {
  AgentMessageDeliverRequest,
  AgentMessageReply
} from '../shared/agents/agent-messaging'
import { AGENT_MESSAGE_VERBS, NOTIFY_BODY } from '../shared/agents/agent-messaging'
import {
  deliverAgentMessage,
  type DeliveryDeps,
  type ReceiptEvent
} from '../core/agents/agent-message'
import {
  RETRYABLE,
  type AgentMessageOutcome,
  type NotPermittedReason
} from '../core/agents/agent-message-decide'
import { noteNewTurn, noteSent, reserveFlow } from '../core/agents/agent-message-flow'
import { recordDelivery } from '../core/agents/agent-message-trace'
import { resolveDeliveryScope, scopeRefusal } from '../core/agents/agent-message-scope'
import { nodeTokenFilePresent } from '../core/agents/node-token-files'
import { mirrorEntry as coreMirrorEntry, type MirrorEntry } from '../core/agent-status-mirror'

/** The little the service needs to know about a stored node. */
export interface MessagingStoredNode {
  id: string
  title?: string
  agentId?: string
}

/**
 * Every side effect and every store read, injected — same reasoning as `DeliveryDeps`: the suite
 * tests the SERVICE (scope→switch→flow→deps→reply) without a pty, a workspace file or a window.
 */
export interface AgentMessagingDeps {
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  sendFramedPayload(nodeId: string, payload: string): Promise<boolean>
  hasLiveSession(nodeId: string): boolean
  mirrorEntry?(nodeId: string): MirrorEntry | undefined
  /** The main-process projects store (`workspaceStore.persistedCanvases()` on the desktop). */
  projects(): readonly { id: string; nodes: readonly MessagingStoredNode[] }[]
  isRemoteNode(nodeId: string): boolean
  /**
   * The per-project switch (Global Constraint 11): messaging is OFF unless the project opted in.
   * PR 6 gives `Project`/`ProjectFileV1` the `agentMessaging` field (validated `=== true` — the
   * file is hostile input) and wires this to it; until then the desktop wires `() => false`, so
   * the verbs ship fail-closed and every delivery answers `notPermitted (switch-off)`.
   */
  messagingEnabled(projectId: string): boolean
  customAgents(): readonly { id: string; launchCmd: string }[] | undefined
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** Test seam: override the receipt subscription. Production uses the module bus below. */
  subscribeReceipts?(cb: (e: ReceiptEvent) => void): () => void
  now?(): number
}

// ── The receipt bus ───────────────────────────────────────────────────────────────────────────
// One tap on the normalized hook-event stream, fanned to per-delivery receipt watches. Fed by
// main/index.ts's `emitAgentStatus` — the same single stream the canvas store and the mobile
// mirror consume, so the receipt can never disagree with the badge about what the target did.
const receiptSubs = new Set<(e: ReceiptEvent) => void>()

function subscribeBus(cb: (e: ReceiptEvent) => void): () => void {
  receiptSubs.add(cb)
  return () => receiptSubs.delete(cb)
}

/**
 * Feed one normalized agent event into messaging: the sender's own `newTurn` resets its fan-out
 * budget (the same edge normalize.ts flags so the renderer can clear per-turn fan-out), and every
 * event is offered to the open receipt watches — which accept only `verified: true`
 * (`watchForReceipt`), so an unverifiable event resets a budget (fail-open, the flow module's
 * designed direction) but can never confirm a delivery (fail-closed, the receipt's).
 */
export function onMessagingAgentEvent(
  e: Pick<NormalizedAgentEvent, 'nodeId' | 'state' | 'newTurn' | 'verified'>
): void {
  if (!e?.nodeId) return
  if (e.newTurn === true) noteNewTurn(e.nodeId)
  const ev: ReceiptEvent = {
    nodeId: e.nodeId,
    newTurn: e.newTurn,
    state: e.state,
    verified: e.verified
  }
  for (const cb of [...receiptSubs]) cb(ev)
}

// ── The per-node delivery lock ────────────────────────────────────────────────────────────────
// Serialises deliveries against the SAME target inside this process. The renderer additionally
// wraps its IPC call in `guardConcurrentRestart(targetNodeId, …)`, which is what keeps a delivery
// out of a restart/wake's un-submitted resume line — the two locks guard different hazards in
// different processes, and neither replaces the other.
const nodeLocks = new Map<string, Promise<unknown>>()

function withNodeLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = nodeLocks.get(nodeId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  nodeLocks.set(
    nodeId,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** The sentence for each `notPermitted` reason — exhaustive by the Record type, like RETRYABLE. */
const NOT_PERMITTED_TEXT: Record<NotPermittedReason, string> = {
  'switch-off':
    'agent messaging is switched off for this project (Settings → Agents enables it per project).',
  'cross-project': 'the target node is not in the sending node\'s project.',
  'self-send': 'a node cannot message itself.',
  'unsupported-edition': 'agent messaging does not exist on this edition.',
  'unaddressable-node-id': 'that node id cannot be addressed safely.'
}

/**
 * Render one typed outcome as the control reply the shim prints and a JSON client parses.
 *
 * The caller is a LANGUAGE MODEL, so whether to retry is stated IN WORDS and sourced from
 * `RETRYABLE` — the test asserts the words and the table can never disagree. `ok` is true only
 * for an outcome whose bytes reached the pane and were (or will be) consumed: `delivered`,
 * `stalled` (the text may already sit in the composer — a retry is a DOUBLE delivery, which is
 * exactly what `watchForReceipt`'s comment warns an ok:false would provoke) and `queued` (PR 7).
 */
export function renderMessageOutcome(o: AgentMessageOutcome): AgentMessageReply {
  const advice = RETRYABLE[o.kind]
    ? 'Retryable — wait, then try once more.'
    : 'Do not retry.'
  const trace = 'traceId' in o ? ` Trace ${o.traceId}${'traced' in o ? ` (${o.traced})` : ''}.` : ''
  switch (o.kind) {
    case 'delivered':
      return {
        ok: true,
        message: `delivered: the target started its turn (signal: ${o.signal}).${trace}`,
        result: o
      }
    case 'stalled':
      return {
        ok: true,
        message:
          `stalled: the message reached the pane but the target started no turn within ` +
          `${o.waitedMs}ms — it may sit unsubmitted in the composer. Do not retry: a second send ` +
          `would deliver the message twice.${trace}`,
        result: o
      }
    case 'queued':
      return {
        ok: true,
        message: `queued at position ${o.position}, expires in ${o.ttlMs}ms.${trace}`,
        result: o
      }
    case 'deliveredToReplacedTarget':
      return {
        ok: false,
        error:
          `deliveredToReplacedTarget: the pane changed hands during delivery ` +
          `(was: ${o.wasPane}, now: ${o.nowPane}); the bytes cannot be unsent and the event is ` +
          `recorded. ${advice}${trace}`,
        result: o
      }
    case 'expired':
      return {
        ok: false,
        error: `expired: the message waited ${o.queuedForMs}ms queued and was dropped. ${advice}${trace}`,
        result: o
      }
    case 'rateLimited':
      return {
        ok: false,
        error: `rateLimited: over the messaging budget — retry after ${o.retryAfterMs}ms.`,
        result: o
      }
    case 'queueFull':
      return {
        ok: false,
        error: `queueFull: the target's queue is at capacity (${o.capacity}). ${advice}`,
        result: o
      }
    case 'targetBusy':
      return {
        ok: false,
        error: `targetBusy: the target is mid-turn (${o.state}). ${advice}`,
        result: o
      }
    case 'targetNotIdleUnknown':
      return {
        ok: false,
        error: `targetNotIdleUnknown: ${o.reason}. ${advice}`,
        result: o
      }
    case 'targetStatusUnverified':
      return {
        ok: false,
        error: `targetStatusUnverified: ${o.note}. ${advice}`,
        result: o
      }
    case 'targetStatusStale':
      return {
        ok: false,
        error:
          'targetStatusStale: the target has a node identity but has not posted a verified ' +
          `status yet. ${advice}`,
        result: o
      }
    case 'targetHookScriptStale':
      return {
        ok: false,
        error: `targetHookScriptStale: ${o.note}. ${advice}`,
        result: o
      }
    case 'targetNotAgentPane':
      return {
        ok: false,
        error:
          `targetNotAgentPane: the target's pane is not running its agent right now ` +
          `(observed: ${o.observed}). ${advice}`,
        result: o
      }
    case 'targetNotPasteAware':
      return {
        ok: false,
        error:
          'targetNotPasteAware: the target pane did not request bracketed paste, and a ' +
          `multi-line message would submit line by line. ${advice}`,
        result: o
      }
    case 'targetGone':
      return {
        ok: false,
        error: `targetGone: no live session exists for the target node. ${advice}`,
        result: o
      }
    case 'notPermitted':
      return {
        ok: false,
        error: `notPermitted (${o.reason}): ${NOT_PERMITTED_TEXT[o.reason]} ${advice}`,
        result: o
      }
  }
}

/** Outcomes whose bytes reached the pane — the only ones that consume flow budget (`noteSent`'s
 *  own contract: "called after the write, not before the gate"). */
const WROTE: ReadonlySet<AgentMessageOutcome['kind']> = new Set([
  'delivered',
  'stalled',
  'deliveredToReplacedTarget'
])

/**
 * One control-verb delivery, end to end: scope → switch → flow → `deliverAgentMessage` → budget →
 * rendered reply.
 */
export async function deliverFromControl(
  req: AgentMessageDeliverRequest,
  deps: AgentMessagingDeps
): Promise<{ outcome: AgentMessageOutcome; reply: AgentMessageReply }> {
  const now = deps.now ?? ((): number => Date.now())
  const answer = (
    outcome: AgentMessageOutcome
  ): { outcome: AgentMessageOutcome; reply: AgentMessageReply } => ({
    outcome,
    reply: renderMessageOutcome(outcome)
  })

  const projects = deps.projects()
  // WHO MAY BE ADDRESSED — the serialized store, never a live canvas (there is nothing to travel
  // toward, by construction: see agent-message-scope.ts). This is also where `isSafeNodeId` runs,
  // which the pair limiter's key and the tmux session namespace both depend on.
  const scope = resolveDeliveryScope(projects, req.sourceNodeId, req.targetNodeId)
  let notPermitted = scopeRefusal(scope)
  const projectId = scope.kind === 'same-project' ? scope.projectId : undefined
  if (!notPermitted && (!projectId || !deps.messagingEnabled(projectId)))
    notPermitted = 'switch-off'

  // Flow control (PR #208), taken as a RESERVATION rather than a pure read: `checkFlowLimits`
  // followed later by `noteSent` is not atomic, and N parallel sends to N distinct targets would
  // all pass the fan-out cap before any of them recorded — the cap would hold only for a sender
  // polite enough to send sequentially. `reserveFlow` checks and holds in one synchronous step;
  // the hold is released in the `finally` below, so a delivery that never reaches the pane still
  // costs nothing (noteSent's own contract). The parallel-sends test in agent-messaging.test.ts
  // is the one that fails if this goes back to a bare check.
  let retryAfterMs: number | undefined
  let reservation: { release(): void } | null = null
  if (!notPermitted) {
    const flow = reserveFlow(req.sourceNodeId, req.targetNodeId, now())
    if (!flow.ok) retryAfterMs = flow.outcome.retryAfterMs
    else reservation = flow
  }

  const owner = projects.find((p) => p.id === projectId)
  const sourceNode = owner?.nodes.find((n) => n.id === req.sourceNodeId)
  const targetNode = owner?.nodes.find((n) => n.id === req.targetNodeId)
  // The spawn-time default (`options.agentId ?? 'claude'`), mirrored: a plain terminal node got
  // the claude hook env at spawn, so its pane is judged against claude's binaries — and a bare
  // shell in it still refuses as `targetNotAgentPane`.
  const targetAgentId = targetNode?.agentId ?? 'claude'

  const delivery: DeliveryDeps = {
    paneOwner: (id) => deps.paneOwner(id),
    // #210 retired the `#{bracket_paste_flag}` probe with a "do not reintroduce" note
    // (pty-manager.ts): pre-3.7 tmux cannot distinguish "the app did not ask" from "I cannot
    // ask". So the dep answers true and the gate never refuses on it. What keeps herdr :260
    // closed instead: gate 1 + gate 2 admit only a VERIFIED-idle supported agent CLI in the
    // pane's foreground, and `agent-message.realtty.test.ts` proves the framed transport lands
    // the envelope as one block against a real paste-aware reader.
    // TODO(pr7): a supported agent CLI idling WITHOUT bracketed paste on is asserted by no test —
    // if one exists, its deliveries splice line-by-line and only the receipt/trace make it
    // visible. Measure per CLI before relying on this any further.
    bracketPasteRequested: async () => true,
    sendFramed: (id, payload) => deps.sendFramedPayload(id, payload),
    mirrorEntry: (id) => (deps.mirrorEntry ?? coreMirrorEntry)(id),
    tokenFilePresent: (id) => nodeTokenFilePresent(id),
    lock: (id, fn) => withNodeLock(id, fn),
    now,
    trace: (input) =>
      recordDelivery(input, {
        appendBoardLog: (entry) =>
          projectId ? deps.appendBoardLog(projectId, entry) : Promise.resolve(false),
        now
      }),
    subscribeEvents: deps.subscribeReceipts ?? subscribeBus
  }

  try {
    const outcome = await deliverAgentMessage(
      {
        targetNodeId: req.targetNodeId,
        sourceNodeId: req.sourceNodeId,
        // The from-line is composed HERE from the store's title (oneLine'd inside buildEnvelope);
        // the renderer never supplies a string that ends up inside the frame.
        sourceTitle: sourceNode?.title || req.sourceNodeId,
        // notify's body is APP-OWNED (#98): substituted here, in main, whatever the request
        // carried — the renderer's `--text` refusal is UX, this line is the boundary. The test
        // sends a hostile body over the IPC shape and asserts it never reaches the envelope.
        body: req.verb === 'notify' ? NOTIFY_BODY : req.body,
        targetAgentId,
        targetBinaries: binariesFor(targetAgentId, deps.customAgents()),
        targetIsRemote: deps.isRemoteNode(req.targetNodeId),
        notPermitted,
        retryAfterMs,
        targetLive: deps.hasLiveSession(req.targetNodeId)
      },
      delivery
    )

    // No await between the record and the release: the recorded send replaces the hold in the
    // same tick, so no concurrent reservation can slip through the seam between them.
    if (WROTE.has(outcome.kind)) noteSent(req.sourceNodeId, req.targetNodeId, now())
    return answer(outcome)
  } finally {
    reservation?.release()
  }
}

/** Guard for the IPC boundary: the request came over a channel, so its shape is asserted here. */
export function isDeliverRequest(x: unknown): x is AgentMessageDeliverRequest {
  const r = x as AgentMessageDeliverRequest | null
  return (
    !!r &&
    typeof r === 'object' &&
    AGENT_MESSAGE_VERBS.has(r.verb) &&
    typeof r.sourceNodeId === 'string' &&
    typeof r.targetNodeId === 'string' &&
    typeof r.body === 'string'
  )
}
