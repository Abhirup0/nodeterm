// WHICH CANVAS answers a canvas-control request — the routing half of the `nodeterm` CLI's
// authorization boundary (Canvas's onAgentControl effect). Pure, so it is unit-testable where the
// React component is not (vitest runs in the node environment); same reasoning as presenceTravel,
// whose project-travel rules this reuses.
//
// WHY IT EXISTS: React Flow only ever holds the ACTIVE project's nodes, but tmux sessions of every
// OTHER open project keep running — they survive an app restart and are re-adopted on boot. Their
// agents still hold NODETERM_CANVAS_CONTROL and still reach the (rewritten) hook endpoint, so their
// control calls arrive at a canvas that has never heard of the source node. Looking the source up
// in the live canvas alone therefore rejected every agent outside the project the app happened to
// come up on — reported as "source node is not a control-capable agent", which is what a node
// carrying a non-control agent gets, so the failure read as a lost capability rather than as the
// wrong canvas answering. Resolve the OWNING project instead, then travel to it (or, for a verb
// that reads and changes nothing, answer straight out of its serialized nodes).

import { canControlCanvas, type AgentId } from '@shared/agents/config'
import { projectTravel } from './presenceTravel'
import {
  projectCapabilityGrantedFor,
  type CapabilityAckMap
} from '@shared/project-capability-consent'

/** The little the routing needs to know about a project (a structural subset of `Project`). */
export interface ControlProject {
  id: string
  closed?: boolean
  unavailable?: boolean
  nodes: readonly { id: string }[]
}

/** A serialized node, as the projects store keeps them for non-active projects. */
export interface StoredNode {
  id: string
  kind?: string
  title?: string
}

/**
 * Where a control request must be applied:
 * - `active`  — the source is on the live canvas (or its project is already active): apply here.
 * - `switch`  — an open project's canvas: activate that tab first.
 * - `reopen`  — a closed project (its sessions still run): restore the tab, then activate it.
 * - `blocked` — a project whose files are unreadable: travelling there would show an empty canvas.
 * - `unknown` — no open project owns this node id.
 */
export type ControlRoute =
  | { kind: 'active' }
  | { kind: 'switch'; projectId: string }
  | { kind: 'reopen'; projectId: string }
  | { kind: 'blocked'; projectId: string }
  | { kind: 'unknown' }

/** Which project owns `sourceNodeId`, and what Canvas must do to be able to act on it. */
export function routeControlSource(
  projects: readonly ControlProject[],
  activeProjectId: string,
  sourceNodeId: string
): ControlRoute {
  const owner = projects.find((p) => p.nodes.some((n) => n.id === sourceNodeId))
  if (!owner) return { kind: 'unknown' }
  const travel = projectTravel(
    projects.map((p) => ({ id: p.id, closed: p.closed, unavailable: p.unavailable, nodes: [] })),
    activeProjectId,
    owner.id
  )
  // `none` means "already there" — the live canvas is the right one even if its store copy lags.
  if (travel.kind === 'none') return { kind: 'active' }
  if (travel.kind === 'blocked') return { kind: 'blocked', projectId: owner.id }
  return travel
}

/**
 * Verbs that are answered from the SERIALIZED store instead of the live canvas.
 *
 * `list` reads names only, and it is the verb an agent calls most — answering it out of the store
 * keeps a background agent's polling from yanking the user's view to another project tab on every
 * call.
 *
 * `send`/`reply` are here for a stronger reason than politeness, and it is worth being precise
 * about WHICH travel this prevents: routing here is by SOURCE
 * (`routeControlSource(projects, activeId, sourceNodeId)`), so what the declaration stops is a trip
 * to the SENDER's project — which an off-canvas orchestrator would otherwise trigger on every
 * message it sent, hijacking the human's view on a background agent's say-so and clearing that
 * node's unread badge via `setActive` on the way (G5). A delivery goes to a tmux PANE, not to a
 * canvas, so it needs no live canvas at either end.
 *
 * The other half — never travelling to the TARGET's project — is not this function's doing. It
 * comes from `resolveDeliveryScope` (`src/core/agents/agent-message-scope.ts`) taking the
 * serialized store and having no live-node parameter at all, so there is nothing to travel toward.
 *
 * LIVE AS OF PR 5: Canvas.tsx's dispatch handles `send`/`reply` BEFORE its source-routing
 * machinery, so neither `routeControlSource` nor any travel runs for them — the declaration here
 * and that early-exit are the same decision stated once each, and `controlRouting.test.ts` pins
 * this half.
 */
/*
 * `sticky` is store-answered for the send/reply reason, not the list reason: its headline use is
 * a SCHEDULED agent rewriting one note every few minutes, and routing is by SOURCE — so a live
 * requirement would yank the human's view to the sync agent's project on every run (G5), which is
 * exactly the behaviour that gets the sync loop turned off. The write lands in the owning
 * project's serialized nodes (`applyNodeMutation`, the same path peer mutations take) when that
 * project is not the active one; the live canvas handles it when it is.
 */
/*
 * `open-project` (issue #338) is store-answered for the G5 reason in its sharpest form: its
 * headline caller is a background orchestrator registering one repo after another, and routing is
 * by SOURCE — a live requirement would yank the human's view to the CALLER's project on every
 * registration (and clear its unread badge via `setActive` on the way). The verb acts on the
 * projects STORE through the non-activating `registerProject`, and its consent dialog is
 * app-global (`ConfirmState` overlays the window), so no live canvas is needed at either end.
 * Canvas.tsx handles it BEFORE the source-routing machinery — this declaration and that
 * early-exit are the same decision stated once each (spec §2.3, P6), pinned by
 * `controlRouting.test.ts`.
 */
const STORE_ANSWERED_VERBS: ReadonlySet<string> = new Set([
  'list',
  'send',
  'reply',
  'sticky',
  'open-project'
])

/**
 * Does this verb have to run against the LIVE canvas? Everything that creates, moves, writes to or
 * closes a node does.
 */
export function needsLiveCanvas(verb: string): boolean {
  return !STORE_ANSWERED_VERBS.has(verb)
}

/**
 * The capability half of the guard: may a session in this node drive the canvas?
 *
 * The empty/absent default MIRRORS pty-manager's spawn-time default (`options.agentId ?? 'claude'`):
 * a plain terminal node received the claude hook env at spawn, so a manual `claude` there holds
 * NODETERM_CANVAS_CONTROL — rejecting it here would contradict the env it was handed.
 */
export function sourceIsControlCapable(agentId: unknown): boolean {
  const id = typeof agentId === 'string' && agentId ? agentId : 'claude'
  return canControlCanvas(id as AgentId)
}

/**
 * The `browser` verb's resolve answer — the two things ONLY the renderer knows, computed purely so
 * Canvas.tsx's IPC handler is a thin wrapper testable here. Main asks over `browserControlResolve`,
 * makes the security decision itself (owner + capability + CDP gate), and does the CDP work; this
 * function NEVER touches a debugger.
 *
 * WHY MAIN STILL DECIDES from these facts: an XSS-in-a-node-title-style bug lands in the renderer,
 * the more attackable half, so the allowlist and the ledger stay main-side. The renderer reports
 * facts (does this node's project exist, is the source control-capable, is the capability on right
 * now — read LIVE via `projectCapabilityGrantedFor`, never cached); main re-orders them into the
 * refusal decision in `browser-drive.ts`.
 */
export interface BrowserResolveNode {
  id: string
  agentId?: unknown
  /** The node's display title — reported so main can make the cookie-read trace human-readable
   *  (PR 9). Never a security input. */
  title?: string
}
export interface BrowserResolveProject {
  id: string
  cwd?: string
  agentBrowserControl?: boolean
  capabilityAck?: CapabilityAckMap
  nodes: readonly BrowserResolveNode[]
}
export type BrowserResolveAnswer =
  | { ok: false; refusal: string }
  | {
      ok: true
      projectId: string
      projectCwd?: string
      sourceControlCapable: boolean
      capabilityOn: boolean
      /** The owner (source) agent node's title and the driven browser node's title — for the cookie
       *  trace only. Empty string when unknown; main falls back to the node id. */
      sourceTitle: string
      browserTitle: string
    }

export function answerBrowserResolve(
  project: BrowserResolveProject | undefined,
  sourceNodeId: string,
  browserNodeId?: string
): BrowserResolveAnswer {
  // No open project owns the source, or the node is not on its canvas: a named, non-revoking
  // refusal. (Same class as every other verb's "source node is not on an open canvas".)
  if (!project) return { ok: false, refusal: 'source node is not on an open canvas' }
  const node = project.nodes.find((n) => n.id === sourceNodeId)
  if (!node) return { ok: false, refusal: 'source node is not on an open canvas' }
  const browserNode = browserNodeId ? project.nodes.find((n) => n.id === browserNodeId) : undefined
  return {
    ok: true,
    projectId: project.id,
    projectCwd: project.cwd,
    sourceControlCapable: sourceIsControlCapable(node.agentId),
    // LIVE read — the drive-time capability check the whole feature's safety rests on. A project.json
    // hand-edit that flipped the switch off is reflected here the next time an agent drives, which is
    // exactly drive time.
    capabilityOn: projectCapabilityGrantedFor(project, 'agentBrowserControl'),
    sourceTitle: typeof node.title === 'string' ? node.title : '',
    browserTitle: typeof browserNode?.title === 'string' ? browserNode.title : ''
  }
}

/** `list`'s rows, built from serialized nodes — the same shape the live canvas answers with
 *  (`n.type` is the persisted `kind`, `n.data.title` the persisted `title`). */
export function storedNodeListing(
  nodes: readonly StoredNode[]
): { id: string; kind: string; title: string }[] {
  return nodes.map((n) => ({ id: n.id, kind: n.kind ?? 'terminal', title: n.title ?? '' }))
}
