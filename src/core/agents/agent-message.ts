import type { MirrorEntry } from '../agent-status-mirror'
import type { AgentState } from '../../shared/agents/normalize'
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'
import { isAgentPane } from '../../shared/agents/pane-owner-predicate'
import { bracketedInjection, PASTE_END, PASTE_START } from '../paste-injection'
import { buildEnvelope, newFrameNonce } from './agent-message-envelope'
import { PANE_PROBE_TIMEOUT_MS, probeWithin } from './pane-probe'
import {
  decideDelivery,
  decidePreProbe,
  type AgentMessageOutcome,
  type DeliveryFacts,
  type NotPermittedReason,
  type ReceiptSignal,
  type TraceKind
} from './agent-message-decide'
import type { DeliveryTraceInput } from './agent-message-trace'

/**
 * `deliverAgentMessage` — ONE primitive: lock, pre-flight, framed write, post-write re-verify,
 * receipt.
 *
 * EVERY side effect is an injected dep. That is not testing ceremony: it is what lets the
 * SEQUENCING be tested without a pty (this file's sibling unit test) while the PANE BEHAVIOUR is
 * tested against a real tmux pane and a real reader (`agent-message.realtty.test.ts`). A structural
 * test can only catch the tricks it was taught, and this repo has twice shipped a defect that a
 * hand-rolled parser passed and a real reader caught.
 */

/** How long the receipt waits for the target's own next turn.
 *
 * 8 s, and deliberately nowhere near the transport ceiling. `CONTROL_CEILING_MS` is 130 s and the
 * desktop's own control await is 120 s, but that headroom exists so a HUMAN CONFIRMATION DIALOG can
 * stay open. Borrowing it for an automated wait makes a stuck receipt look like a stuck dialog,
 * which is the one thing the person debugging this must be able to tell apart. herdr uses ~5 s; 8
 * gives a slow codex start room without approaching either bound.
 *
 * The receipt is also what makes deliver-on-idle safe (PR 7): a queued message that is never
 * consumed surfaces as an error instead of vanishing.
 */
export const RECEIPT_DEADLINE_MS = 8000

/** The subset of a normalized hook event the receipt reads. Deliberately narrow: the receipt must
 *  not become a second status pipeline. */
export interface ReceiptEvent {
  nodeId: string
  newTurn?: boolean
  state?: AgentState
  /** The POST presented a per-node token this instance minted for this node id. */
  verified?: boolean
}

export interface DeliveryRequest {
  targetNodeId: string
  sourceNodeId: string
  sourceTitle: string
  body: string
  /** The agent the TARGET node is configured to run — gate 1 checks the pane against its binaries. */
  targetAgentId: string
  /** `binariesFor(agentId, settings.customAgents)`. Null/absent ⇒ the pane cannot be named ⇒ the
   *  verdict is `unknown` ⇒ refuse. A caller holding the settings should always pass it, or every
   *  custom agent is permanently unreachable behind a retryable-looking error. */
  targetBinaries?: readonly string[] | null
  /** Is the target on an SSH project? Only changes which ACTION a stale-script refusal names. */
  targetIsRemote?: boolean
  /** Set by PR 5 / PR 6. Present ⇒ the cheapest possible refusal, with no round-trip at all. */
  notPermitted?: NotPermittedReason
  /** Set by PR 4's per-pair limiter. */
  retryAfterMs?: number
  /**
   * Does a live session exist for this node at all? Supplied by the caller (the shell knows;
   * `src/core` does not), defaulting to true.
   *
   * Deliberately NOT derived from an unreadable pane. `paneOwner` answers null for a dead pane AND
   * for a tmux that is missing, a `ps` that failed, a lapsed deadline — calling all of those "the
   * node is gone" would be a confident answer to a question we did not ask. An unreadable pane is
   * `targetNotAgentPane` with `observed: 'unknown'`; only a node with no session is `targetGone`.
   */
  targetLive?: boolean
}

/**
 * Every side effect, injected.
 *
 * ── G5: NOTHING HERE TOUCHES THE UNREAD BIT ─────────────────────────────────────────────────────
 *
 * There is deliberately no `clearUnread`, no `setActive`, and no way to reach either: a delivery is
 * not a human reading a node, and a feature that quietly marks a node read on every message would
 * erase exactly the signal the human relies on. The unit test asserts this over the dep record's
 * KEYS, by running a delivery through a Proxy that refuses any key outside this interface — so the
 * guarantee is checked by execution, not by grepping this file for a name.
 */
export interface DeliveryDeps {
  /** Kernel truth about the target's pane. Unbounded by contract — this module bounds it. */
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  /** tmux's `#{bracket_paste_flag}` for the target's pane. */
  bracketPasteRequested(nodeId: string): Promise<boolean>
  /** ONE write: the framed text and the Enter together. Resolves false when the pane is gone. */
  sendFramed(nodeId: string, payload: string): Promise<boolean>
  /** The target's status mirror entry — gate 2's whole input. */
  mirrorEntry(nodeId: string): MirrorEntry | undefined
  /** `nodeTokenFilePresent(nodeId)`. */
  tokenFilePresent(nodeId: string): boolean
  /** Serialises everything below against the same target. */
  lock<T>(nodeId: string, fn: () => Promise<T>): Promise<T>
  now(): number
  /** Per-delivery frame nonce. Injected so a test can pin it; defaults to `newFrameNonce`. */
  nonce?(): string
  /** Records the outcome (Task 3.5) and answers where it landed. */
  trace(input: DeliveryTraceInput): Promise<{ traceId: string; traced: TraceKind }>
  /** Subscribe to hook events for the receipt. Returns an unsubscribe. */
  subscribeEvents(cb: (e: ReceiptEvent) => void): () => void
}

/**
 * Is the pane we just wrote into still the pane we checked?
 *
 * NOT argv equality, and the difference matters. An agent's foreground process group changes
 * constantly while it works — a tool subprocess joins the group and the argv list grows — so
 * argv equality would report a REPLACED TARGET on every busy pane and turn a real signal into
 * noise nobody reads. What identifies the pane is the pane: same tty, same pane pid, and still
 * owned by the same agent.
 *
 * `after === null` is NOT treated as "same". A probe that lapsed cannot confirm anything, and the
 * fail-open direction here is to TELL the sender: an unconfirmable delivery is reported as
 * `deliveredToReplacedTarget` with `nowPane: 'unknown'`, never as `delivered`.
 */
function samePane(
  before: PaneOwner,
  after: PaneOwner | null,
  agentId: string,
  binaries: readonly string[] | null | undefined
): boolean {
  if (!after) return false
  if (after.tty !== before.tty || after.panePid !== before.panePid) return false
  return isAgentPane(after, agentId, binaries) === 'agent'
}

/**
 * Wait for the target's own next turn, or give up and say so.
 *
 * rev. 2 had NO receipt at all, so it could not distinguish "B read it" from "the body is sitting
 * in B's composer with no submit" — the failure herdr's CHANGELOG records twice, and the exact
 * failure `isAgentPane`'s first caveat predicts (an agent in the foreground group whose stdin is a
 * pipe never reads the bytes).
 *
 * `newTurn` is the signal, and it is emitted by ALL FIVE supported agents on turn start (claude
 * UserPromptSubmit, codex, gemini, opencode, grok — measured in their normalizers). The bare
 * `working` transition is a documented FALLBACK for an agent whose hooks are misconfigured, not for
 * a whole agent, and the outcome records which of the two was used so a stalling install is
 * diagnosable from the trace.
 *
 * The receipt must itself be VERIFIED. An adversary that could fake a receipt could confirm its own
 * deliveries, which is the same hole gate 2 exists to close — the cost of an unverified receipt is
 * not "a slightly wrong log", it is that PR 7's queue would consider a message consumed.
 */
export async function awaitReceipt(
  nodeId: string,
  subscribe: DeliveryDeps['subscribeEvents'],
  deadlineMs: number = RECEIPT_DEADLINE_MS
): Promise<ReceiptSignal | null> {
  return new Promise<ReceiptSignal | null>((resolve) => {
    let done = false
    let unsub: () => void = () => {}
    const finish = (signal: ReceiptSignal | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        unsub()
      } catch {
        // an unsubscribe that throws must not turn a delivered message into a rejection
      }
      resolve(signal)
    }
    const timer = setTimeout(() => finish(null), deadlineMs)
    unsub = subscribe((e) => {
      if (e.nodeId !== nodeId) return // another node's turn is not this node's receipt
      if (e.verified !== true) return // an unverifiable event is not evidence, here as everywhere
      if (e.newTurn === true) return finish('newTurn')
      if (e.state === 'working') return finish('working')
    })
    if (done) unsub() // a synchronous event during subscribe already resolved us
  })
}

/**
 * Deliver one message into one target node's pane.
 *
 * The whole run is inside the lock — not just the write. `guardConcurrentRestart`'s own comment is
 * the reason: *"a second /exit arriving while the resume line sits un-submitted…"*. A pre-flight
 * that is outside the lock is a pre-flight whose answer can be false before the write happens.
 */
export async function deliverAgentMessage(
  req: DeliveryRequest,
  deps: DeliveryDeps
): Promise<AgentMessageOutcome> {
  return deps.lock(req.targetNodeId, async () => {
    // The free gates first, and this ordering is load-bearing rather than tidy: a caller that is
    // not permitted or is over its rate budget must be refused WITHOUT a tmux round-trip (and, on
    // an SSH project, without an `ssh` one). The unit test asserts the probe never happens.
    const cheap = decidePreProbe({
      notPermitted: req.notPermitted,
      retryAfterMs: req.retryAfterMs,
      targetLive: req.targetLive ?? true
    })
    if (cheap) return cheap

    // ── DO NOT RETRY AN `unknown` PANE VERDICT ON A FIXED SHORT TIMER WITHOUT A CIRCUIT BREAKER ──
    //
    // `probeWithin` abandons the WAIT, not the WORK. Measured: it answers null at 2.0s while the
    // `ssh` child it started lives until `runAsync`'s own 15s reap, so a 2s retry loop stacks ~7
    // overlapping children per pane. `childArgs` carries `-o ControlMaster=auto`, so against a DEAD
    // master each of those children does not multiplex — it opens a full connection, i.e. a REAL
    // LOGIN. A pane that is unreadable *because* its master died is therefore the worst case, and
    // it is the shape this repo already lived through at 72k logins/day (memory:
    // ssh-controlmaster-fallback). This module probes AT MOST TWICE per delivery and never loops;
    // any caller that wants to retry an `unknown` needs backoff plus a per-target cap BEFORE its
    // second attempt, not after the incident.
    const before = await probeWithin(() => deps.paneOwner(req.targetNodeId), PANE_PROBE_TIMEOUT_MS)
    const verdict = isAgentPane(before, req.targetAgentId, req.targetBinaries)
    const facts: DeliveryFacts = {
      notPermitted: req.notPermitted,
      retryAfterMs: req.retryAfterMs,
      targetLive: req.targetLive ?? true,
      pane: verdict,
      paneObserved: before?.command,
      target: deps.mirrorEntry(req.targetNodeId),
      tokenFilePresent: deps.tokenFilePresent(req.targetNodeId),
      targetIsRemote: req.targetIsRemote
      // `pasteAware` deliberately absent: the flag costs a second tmux round-trip and there is no
      // point paying for it to tell a rate-limited caller something it cannot act on.
    }
    const gate = decideDelivery(facts)
    if (gate.kind !== 'proceed') return gate
    // `before` is non-null here: `isAgentPane(null, …)` is `unknown`, which the gate refused.
    const owner = before as PaneOwner

    // herdr :260 — a multi-line envelope on the UNFRAMED fallback would be submitted line by line
    // as separate turns. It is refused, never sent and hoped for.
    if (!(await deps.bracketPasteRequested(req.targetNodeId))) return { kind: 'targetNotPasteAware' }

    // herdr :48 — the text and the Enter ride ONE write. Two writes race the receiving TUI's paste
    // heuristics, and an Enter arriving milliseconds behind the text is absorbed as pasted content
    // instead of a submit, leaving the prompt composed but unsubmitted.
    //
    // herdr :116 — the frame is applied ONLY because the pane asked for bracketed paste above.
    // Framing an unaware app made OpenCode read `A != B` as shell mode.
    const payload = bracketedInjection(
      buildEnvelope({
        nonce: (deps.nonce ?? newFrameNonce)(),
        sourceId: req.sourceNodeId,
        sourceTitle: req.sourceTitle,
        replyTo: req.sourceNodeId,
        body: req.body
      }),
      true
    )
    const wrote = await deps.sendFramed(req.targetNodeId, payload)
    // The pane went away between the gate and the write. Not a failure of ours and not retryable:
    // the node is gone.
    if (!wrote) return { kind: 'targetGone' }

    const bodyChars = req.body.length
    const trace = async (
      outcome: AgentMessageOutcome['kind'],
      receipt?: ReceiptSignal
    ): Promise<{ traceId: string; traced: TraceKind }> =>
      deps.trace({
        sourceNodeId: req.sourceNodeId,
        sourceTitle: req.sourceTitle,
        targetNodeId: req.targetNodeId,
        outcome,
        ...(receipt ? { receipt } : {}),
        bodyChars
      })

    // G3, post-write. rev. 2's gate 3 was check-then-act — a TOCTOU where the body lands in a
    // stranger's shell. The post-check CANNOT un-send the bytes; the residual window is unchanged.
    // What it buys is that the sender is TOLD and the trace records it, and that
    // `deliveredToReplacedTarget` is never reported as success.
    const after = await probeWithin(() => deps.paneOwner(req.targetNodeId), PANE_PROBE_TIMEOUT_MS)
    if (!samePane(owner, after, req.targetAgentId, req.targetBinaries)) {
      const t = await trace('deliveredToReplacedTarget')
      return {
        kind: 'deliveredToReplacedTarget',
        traceId: t.traceId,
        traced: t.traced,
        wasPane: owner.command,
        nowPane: after?.command ?? 'unknown'
      }
    }

    const signal = await awaitReceipt(req.targetNodeId, deps.subscribeEvents, RECEIPT_DEADLINE_MS)
    if (!signal) {
      const t = await trace('stalled')
      return { kind: 'stalled', traceId: t.traceId, traced: t.traced, waitedMs: RECEIPT_DEADLINE_MS }
    }
    const t = await trace('delivered', signal)
    return { kind: 'delivered', traceId: t.traceId, traced: t.traced, receipt: 'observed', signal }
  })
}

/** Re-exported so a caller building a payload assertion uses the same markers the framer does. */
export { PASTE_START, PASTE_END }
