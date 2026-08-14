/**
 * What a per-node token BUYS, per route: the policy that turns the three-way verdict from
 * `verifyNodeToken` into allow / allow-with-warning / refuse.
 *
 * The whole identity series up to here is measurement — it can say `verified`, `legacy`, `forged`
 * and it labels events with the answer, but nothing has ever DEPENDED on it. This file is where it
 * starts to. That is the dangerous half, because the population it governs is already running:
 * tmux sessions outlive the app, so on the day this ships there are live agent sessions holding a
 * launcher, a skill shim and an environment from before the token existed. Enforce on day one and
 * their next `manage-nodeterm-canvas` call stops working with no way for them to know why.
 *
 * So enforcement arrives in two moves, and both are here rather than scattered through the routes:
 *
 *  1. TRUST ON FIRST PROOF. A node that has never presented a token this instance minted keeps the
 *     legacy path. A node that HAS is latched: an unverified request naming it afterwards is
 *     refused, because that session demonstrably CAN authenticate and one that suddenly cannot is
 *     either a different process wearing its node id or a forgery this instance cannot name. The
 *     latch costs the legacy population nothing — they never prove anything, so they never latch.
 *
 *  2. A DATED WINDOW. Until `NODE_IDENTITY_STRICT_AFTER` an unverified MUTATION still executes and
 *     the reply carries `IDENTITY_RESTART_NOTE`, which names the fix and the date. After it, the
 *     same situation is a refusal. The date is in the source, not in a comment saying "later":
 *     a tightening with no date is a tightening that never happens.
 */
import type { NodeTokenVerdict } from './node-auth-token'

/**
 * When an unverified mutation stops executing and starts being refused.
 *
 * The owner's rule was "the second minor release OR 60 days after the shipping release, whichever
 * is LATER", resolved here to the concrete instant that rule lands on. Resolved, not computed: a
 * date the code can print is a date a user can plan around, and a rule that has to be re-derived
 * from a release calendar is a rule that quietly never fires. Also in docs/node-identity.md.
 */
export const NODE_IDENTITY_STRICT_AFTER = new Date('2026-10-13T00:00:00Z')

/** The date as the user reads it. Derived, so the sentence and the constant cannot drift apart. */
const STRICT_DATE = NODE_IDENTITY_STRICT_AFTER.toISOString().slice(0, 10)

/**
 * Prefixed onto the reply of an unverified mutation that STILL RAN.
 *
 * It says what could not be established, that the command ran anyway, the exact action that fixes
 * it, and the date after which it stops being a note and starts being a refusal. One line, because
 * it is a prefix and a multi-line prefix buries the reply the agent actually asked for.
 */
export const IDENTITY_RESTART_NOTE =
  'NodeTerm could not confirm which node sent this command: this session is not presenting its ' +
  'node identity, so it ran unverified. Restart this node (right-click it, "Restart agent") to ' +
  `pick one up — from ${STRICT_DATE} commands from a session without one are refused.`

/**
 * The same situation once it is refused — after the cutoff, or once the node has proven itself and
 * an unverified caller turns up anyway.
 *
 * Deliberately carries NO date: it fires on both sides of the cutoff (the latch does not wait for
 * it), and a sentence that says "since <date>" would be false for half of the cases it answers.
 */
export const IDENTITY_REFUSED_NOTE =
  'NodeTerm could not confirm which node sent this command, so it did not run: this session is ' +
  'not presenting its node identity. Restart this node (right-click it, "Restart agent") to pick ' +
  'one up.'

/**
 * Control verbs that an unproven, unverified caller may still run after the cutoff.
 *
 * `list` is the whole bucket: it leaks the shape of the canvas — node ids, titles, which agent is
 * where — and it changes nothing. Refusing it would break every legacy client's ability to even
 * ORIENT itself, permanently, for a leak that a caller already holding the shared bearer could get
 * from a dozen other places. Nothing that acts on the canvas belongs in here, and in particular not
 * the confirm-gated pair (`write`, `close`): tolerance would be the one way this feature could
 * weaken the human confirmation, which it must never do.
 */
export const TOLERANT_CONTROL_VERBS = new Set(['list'])

/**
 * The verb `/context-link/*` presents to `controlPolicy`.
 *
 * Every context-link verb is a READ — the route hands back a rendered transcript, summary or
 * terminal capture and changes nothing — so the whole route belongs in the same bucket as `list`.
 * Saying that with a named constant keeps it ONE bucket rather than two lists that drift.
 */
export const CONTEXT_LINK_POLICY_VERB = 'list'

export type IdentityDecision = 'allow' | 'allow-with-warning' | 'refuse'

export interface ControlPolicyInput {
  /** What `verifyNodeToken` made of the presented header. */
  verdict: NodeTokenVerdict
  /**
   * Has THIS node ever presented a token this instance minted for it?
   *
   * The caller is responsible for one subtlety: a FOREIGN kid (another instance's token — the
   * documented cross-instance failover) must arrive here as `proven: false`, even for a node that
   * has latched. It is `legacy` for the same reason it is `legacy` in `verifyNodeToken`: this
   * instance has no standing to judge another instance's credential, and latching against one
   * would break failover on the day a second instance appears.
   */
  proven: boolean
  /** The control verb; `CONTEXT_LINK_POLICY_VERB` for a context-link read. */
  verb: string
  /** Injected, never `Date.now()` inside: a suite has to be able to stand on both sides of the
   *  cutoff without touching the machine clock. */
  now: Date
  /** `settings.hookIdentityStrict`. `undefined` ⇒ follow the constant. */
  override?: boolean
}

/**
 * Pure. Every route decision in this feature comes from this one table:
 *
 *   forged                                    → refuse   (the one unambiguous attack signal)
 *   verified                                  → allow
 *   legacy + latched                          → refuse   (trust on first proof)
 *   legacy + tolerant verb                    → allow    (the legacy population's read path)
 *   legacy + mutation, inside the window      → allow-with-warning
 *   legacy + mutation, past the cutoff        → refuse
 *
 * `override === false` is the escape hatch: it releases the LATCH as well as the cutoff, because
 * the latch is the likelier of the two to have stranded a user whose upgrade went wrong, and a
 * hatch that does not rescue them is not a hatch. It never releases `forged`.
 */
export function controlPolicy({
  verdict,
  proven,
  verb,
  now,
  override
}: ControlPolicyInput): IdentityDecision {
  if (verdict === 'forged') return 'refuse'
  if (verdict === 'verified') return 'allow'
  if (override === false) {
    return TOLERANT_CONTROL_VERBS.has(verb) ? 'allow' : 'allow-with-warning'
  }
  if (proven) return 'refuse'
  if (TOLERANT_CONTROL_VERBS.has(verb)) return 'allow'
  const strict = override ?? now.getTime() >= NODE_IDENTITY_STRICT_AFTER.getTime()
  return strict ? 'refuse' : 'allow-with-warning'
}
