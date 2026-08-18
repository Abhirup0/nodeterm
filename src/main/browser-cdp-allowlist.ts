/**
 * THE CDP allowlist. The single gate every command bound for `debugger.sendCommand` passes through
 * (the one caller is `browser-cdp-send.ts`, pinned structurally by this file's test). Default-DENY:
 * an unknown method, or a known method with a parameter the validator rejects, is REFUSED — nothing
 * falls through.
 *
 * It is NOT a set of method names. The danger in a page-side-eval command is not its name, it is one
 * parameter — and a name-keyed list also cannot express the URL check on Page.navigate. So the table
 * is (method, params-validator) pairs, each validator inspecting exactly the parameters that make its
 * method safe or not.
 *
 * Lives in `src/main`, enforced on the way into the debugger — NEVER in the renderer (the half an
 * XSS-in-a-node-title style bug lands in) and never in the shim or a skill document. Browser control
 * exists only on the Electron desktop; Server Edition / Mobile never reach here.
 *
 * Excluded outright and for stated reasons: arbitrary page-side evaluation
 * (Runtime.evaluate/compileScript/runScript/addBinding) and the whole Debugger domain (a second route
 * to it), Fetch (request interception is a proxy for the user's session), Security (can disable
 * certificate errors), Storage / IndexedDB / DOMStorage (the token stores this whole design exists to
 * keep out), DOM.getOuterHTML / getAttributes (the full-DOM read arriving by another door),
 * Page.bringToFront (a page that can raise itself can steal a click the user aimed elsewhere) and
 * Network.getAllCookies (one call empties the jar for every site the profile ever touched, and no
 * useful audit line names a domain). None of these is in the table, so default-deny refuses them.
 */
import { isNtScript } from './browser-nt-scripts'
import { normalizeAddress } from '@shared/browserUrl'

/** What the gate needs to know about the page beyond the command itself: the viewport from the last
 *  `Page.getLayoutMetrics`, so a mouse coordinate can be bounded to what is actually on screen. */
export interface CdpContext {
  viewport: { width: number; height: number }
}

type Validator = (params: unknown, ctx: CdpContext) => boolean

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A CDP argument for the call-a-function-on-object method is safe ONLY if it carries a single scalar
 *  `value` — never an `objectId` (an agent-chosen live handle) and never a structured value (an
 *  object literal is a re-entry point for logic the NT_SCRIPTS scan never saw). */
function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}
function valueOnlyArgs(args: unknown): boolean {
  if (args === undefined) return true
  if (!Array.isArray(args)) return false
  return args.every(
    (a) =>
      isRecord(a) &&
      Object.keys(a).length === 1 &&
      Object.prototype.hasOwnProperty.call(a, 'value') &&
      isScalar(a.value)
  )
}

const MAX_SELECTOR = 1024
const MAX_INSERT_TEXT = 8192

/**
 * The table. Every entry is a (method, validator) pair. A Map — not a plain object — so a method
 * named `__proto__` / `constructor` can never resolve a validator off Object.prototype.
 */
const ALLOW = new Map<string, Validator>([
  // ---- Agent-facing verbs (PRs 7-8). Each validator inspects the parameters that make it safe. ----

  // The only navigation the agent can drive is to an http(s) URL, decided by the SAME
  // `normalizeAddress` the address bar uses — javascript:/file:/data: all normalize to null.
  ['Page.navigate', (p) => isRecord(p) && typeof p.url === 'string' && normalizeAddress(p.url) !== null],

  // Page-side logic runs ONLY as an NT_SCRIPTS entry, by identity, returning a value, with scalar
  // arguments. This is where the exclusion of arbitrary evaluation is actually enforced.
  [
    'Runtime.callFunctionOn',
    (p) =>
      isRecord(p) &&
      typeof p.functionDeclaration === 'string' &&
      isNtScript(p.functionDeclaration) &&
      p.returnByValue === true &&
      valueOnlyArgs(p.arguments)
  ],

  // A synthesized mouse event must land inside the reported viewport — a coordinate off-screen is
  // either a bug or an attempt to reach chrome the user cannot see.
  [
    'Input.dispatchMouseEvent',
    (p, ctx) =>
      isRecord(p) &&
      typeof p.type === 'string' &&
      typeof p.x === 'number' &&
      typeof p.y === 'number' &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x <= ctx.viewport.width &&
      p.y <= ctx.viewport.height
  ],

  // Typed text is capped; the text goes to insertText, never to a shell and never spliced anywhere.
  ['Input.insertText', (p) => isRecord(p) && typeof p.text === 'string' && p.text.length <= MAX_INSERT_TEXT],

  // A bounded selector against a known node.
  [
    'DOM.querySelector',
    (p) =>
      isRecord(p) &&
      typeof p.nodeId === 'number' &&
      typeof p.selector === 'string' &&
      p.selector.length <= MAX_SELECTOR
  ],

  // A shallow document read only (0 <= depth <= 1, no pierce) — the deep read is the full-DOM door
  // that getOuterHTML/getAttributes are excluded to keep shut. NEGATIVE depth is refused too: in CDP
  // `depth: -1` means the ENTIRE subtree, the same full-DOM read arriving by a signed-number door
  // (Task 7.6). Our own read code passes depth:0; this is the belt.
  [
    'DOM.getDocument',
    (p) =>
      isRecord(p) &&
      (p.depth === undefined || (typeof p.depth === 'number' && p.depth >= 0 && p.depth <= 1)) &&
      p.pierce !== true
  ],

  // A cookie READ must name at least one URL — never the whole jar (that is getAllCookies, excluded).
  [
    'Network.getCookies',
    (p) => isRecord(p) && Array.isArray(p.urls) && p.urls.length > 0 && p.urls.every((u) => typeof u === 'string')
  ],

  // Cookie WRITES stay LISTED so the allowlist records owner decision 5, but no verb reaches them in
  // v1 (pinned by PR 9 Task 9.4). A write needs one explicit domain — never a jar-wide write.
  [
    'Network.setCookie',
    (p) =>
      isRecord(p) &&
      typeof p.name === 'string' &&
      typeof p.value === 'string' &&
      typeof p.domain === 'string' &&
      p.domain.length > 0
  ],

  // ---- Session lifecycle (issued by the lease, browser-lease.ts, not by an agent verb). Still gated
  //      here so the "single gate" property is literal: every sendCommand, infra or not, is checked. ----

  ['Page.enable', () => true],
  ['DOM.enable', () => true],
  ['Runtime.enable', () => true],
  ['Page.getLayoutMetrics', () => true],
  // Enable the Network domain so `--nav` can read the MAIN-FRAME response status from
  // Network.responseReceived (an event feeding our own state — nothing is streamed to the agent,
  // asserted in browser-actions.test.ts). It carries no read power itself; getAllCookies stays out.
  ['Network.enable', () => true],
  // The final URL after a `--nav` (redirects resolved). Read-only, no parameters that matter.
  ['Page.getNavigationHistory', () => true],
  // The read family's chain: getDocument(depth<=1) → resolveNode(nodeId) → callFunctionOn → releaseObject.
  // resolveNode turns OUR shallow document node into an execution-context object handle for the frozen
  // NT_SCRIPTS reader; the nodeId comes from our own getDocument, never from the agent.
  ['DOM.resolveNode', (p) => isRecord(p) && typeof p.nodeId === 'number'],
  // Free the object handle callFunctionOn ran against. objectId is our own, from resolveNode.
  ['Runtime.releaseObject', (p) => isRecord(p) && typeof p.objectId === 'string' && p.objectId.length > 0],
  // Flat-mode child attach only (S8): a nested/auto-attach mode is a different, unaudited surface.
  [
    'Target.attachToTarget',
    (p) => isRecord(p) && p.flatten === true && typeof p.targetId === 'string' && p.targetId.length > 0
  ],
  ['Target.detachFromTarget', (p) => isRecord(p) && typeof p.sessionId === 'string']
])

/**
 * Is this exact (method, params) pair allowed, for this page context? Default-deny: an unknown
 * method returns false with NO per-method detail (an allowlist that explains itself is a probing
 * aid), and a validator that throws on a malformed payload is treated as a refusal.
 */
export function checkCdpCommand(method: string, params: unknown, ctx: CdpContext): boolean {
  const validate = ALLOW.get(method)
  if (!validate) return false
  try {
    return validate(params, ctx) === true
  } catch {
    return false
  }
}
