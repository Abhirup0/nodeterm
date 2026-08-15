/**
 * The agent-messaging verbs' wire shapes — shared because three projects touch them: the renderer
 * dispatch (Canvas.tsx forwards a control verb to main), the preload bridge, and the main-side
 * delivery service. Everything with behaviour stays in `src/core/agents/agent-message*`; this file
 * is deliberately types + one constant.
 */

export type AgentMessageVerb = 'send' | 'reply'

export const AGENT_MESSAGE_VERBS: ReadonlySet<string> = new Set([
  'send',
  'reply'
] satisfies AgentMessageVerb[])

/** What the renderer forwards to main for one delivery. Deliberately minimal: the source TITLE,
 *  the target's agent id, remoteness, the scope verdict and the switch state are all resolved in
 *  MAIN from its own stores, so nothing that ends up inside the envelope or inside an
 *  authorization decision is renderer-supplied beyond the two node ids and the body. */
export interface AgentMessageDeliverRequest {
  verb: AgentMessageVerb
  sourceNodeId: string
  targetNodeId: string
  /** The sender's text. */
  body: string
}

/** The rendered control reply for one delivery — the exact shape every other control verb answers
 *  with, so the hook server and the shim need no messaging-specific branch. */
export interface AgentMessageReply {
  ok: boolean
  message?: string
  error?: string
  /** The typed outcome (an `AgentMessageOutcome` from `src/core`), for JSON clients. */
  result?: unknown
}
