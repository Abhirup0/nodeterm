/**
 * The agent-messaging verbs' wire shapes — shared because three projects touch them: the renderer
 * dispatch (Canvas.tsx forwards a control verb to main), the preload bridge, and the main-side
 * delivery service. Everything with behaviour stays in `src/core/agents/agent-message*`; this file
 * is deliberately types + one constant.
 */

export type AgentMessageVerb = 'send' | 'reply' | 'notify'

export const AGENT_MESSAGE_VERBS: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'notify'
] satisfies AgentMessageVerb[])

/** What the renderer forwards to main for one delivery. Deliberately minimal: the source TITLE,
 *  the target's agent id, remoteness, the scope verdict and the switch state are all resolved in
 *  MAIN from its own stores, so nothing that ends up inside the envelope or inside an
 *  authorization decision is renderer-supplied beyond the two node ids and the body. */
export interface AgentMessageDeliverRequest {
  verb: AgentMessageVerb
  sourceNodeId: string
  targetNodeId: string
  /** The sender's text for send/reply. IGNORED for notify — its body is app-owned and composed
   *  in main (`NOTIFY_BODY`), which is the whole point of that verb. */
  body: string
}

/**
 * `notify`'s entire body — fixed, app-owned, and substituted in MAIN whatever the request
 * carries. Folded in from PR #98, whose design line survives verbatim: "The app owns the entire
 * prompt so the source cannot inject instructions through command arguments." #98's "check your
 * configured inbox" wording is dropped — the product has no inbox concept; the linked context is
 * the thing a notified agent can actually read.
 */
export const NOTIFY_BODY =
  'A linked agent updated shared coordination context. Read the latest linked context ' +
  '(get-linked-context) before continuing.'

/** The rendered control reply for one delivery — the exact shape every other control verb answers
 *  with, so the hook server and the shim need no messaging-specific branch. */
export interface AgentMessageReply {
  ok: boolean
  message?: string
  error?: string
  /** The typed outcome (an `AgentMessageOutcome` from `src/core`), for JSON clients. */
  result?: unknown
}
