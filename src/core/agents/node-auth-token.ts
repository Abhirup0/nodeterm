import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Per-node capability, derived rather than minted-and-stored.
 *
 * Derived is the only shape that survives the restart constraint: tmux sessions outlive the app,
 * so a table minted at spawn is empty for every already-running session after a restart, and there
 * is no way to rebuild it (a node's tmux session can exist with no record on our side). A
 * derivation over a stable input lives exactly as long as the secret, which is the lifetime the
 * endpoint file already assumes.
 *
 *   kid   = base64url(HMAC-SHA256(secret, "nt-node-auth-kid-v1"))[0..8]
 *   mac   = base64url(HMAC-SHA256(secret, "nt-node-auth-v1|" + nodeId))
 *   token = kid + "." + mac
 *
 * The prefix is domain separation, so the same secret can later mint other capability CLASSES (a
 * per-node relay capability, a per-project one) without one being a valid other. #167 hashed the
 * bare nodeId; it is retrofitted onto this derivation in a later task.
 */
export const NODE_ID_CHARSET = /^[A-Za-z0-9._-]+$/
const KID_CONTEXT = 'nt-node-auth-kid-v1'
const MAC_PREFIX = 'nt-node-auth-v1|'
const MAX_NODE_ID = 128

/**
 * The charset alone is NOT enough: `.` and `..` both MATCH `NODE_ID_CHARSET`, and this id is also a
 * path segment under the token dir (`<tokenDir>/<nodeId>`). A `..` there would resolve to the token
 * dir's PARENT. The nodeId is attacker-controlled — it arrives from `project.json`, which travels in
 * cloned/shared repos — so refuse `.` and `..` by name, refuse empty, refuse over-length, BEFORE the
 * id ever reaches a hash or a path join.
 */
export function isSafeNodeId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_NODE_ID &&
    id !== '.' &&
    id !== '..' &&
    NODE_ID_CHARSET.test(id)
  )
}

export function nodeAuthKid(secret: Buffer): string {
  return createHmac('sha256', secret).update(KID_CONTEXT).digest('base64url').slice(0, 8)
}

/** '' for an unsafe node id — never a token, and never a hash of attacker-shaped input. */
export function nodeAuthToken(secret: Buffer, nodeId: string): string {
  if (!isSafeNodeId(nodeId)) return ''
  const mac = createHmac('sha256', secret).update(`${MAC_PREFIX}${nodeId}`).digest('base64url')
  return `${nodeAuthKid(secret)}.${mac}`
}

export type NodeTokenVerdict = 'verified' | 'legacy' | 'forged'

/**
 * Three-way, not two-way. `legacy` is NOT a failure — it is "we cannot judge this", and per-route
 * policy decides what that means (a missing token, or another instance's kid during the documented
 * cross-instance failover). `forged` — our kid with a bad mac — is the ONLY unambiguous attack
 * signal we have and is a 403 on every route, including /hook/*.
 */
export function verifyNodeToken(
  secret: Buffer | null,
  nodeId: string,
  presented: string | string[] | undefined
): NodeTokenVerdict {
  if (!secret) return 'legacy' // no secret ⇒ open (mixed-version machines during rollout)
  if (typeof presented !== 'string' || presented === '') return 'legacy'
  const dot = presented.indexOf('.')
  if (dot <= 0) return 'legacy' // not our wire shape at all
  // The kid is a NON-SECRET routing decision, so a plain compare is correct and cheap; only the
  // full-token compare gets the constant-time treatment, and only once the kid says the token is
  // ours to judge. A foreign kid is the failover path and must be `legacy`, never `forged`.
  if (presented.slice(0, dot) !== nodeAuthKid(secret)) return 'legacy'
  const expected = nodeAuthToken(secret, nodeId)
  if (!expected) return 'forged' // our kid, unusable node id ⇒ forgery, not legacy
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b) ? 'verified' : 'forged'
}
