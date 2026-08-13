import type { AgentNodeStatus } from '../state/agentStatus'
import type { AgentId } from '@shared/agents/config'
import type { NodeKind } from '@shared/types'
import { hasUsage } from '@shared/agents/config'
import type { SshConnection } from '@shared/ssh'

export interface SessionNodeInput {
  id: string
  kind: NodeKind
  title: string
  color: string
  agentId?: AgentId
  cwd?: string
  ssh?: SshConnection
  /** Parent group node id when this node lives inside a canvas group frame. */
  parentId?: string
}

export interface ProjectInput {
  id: string
  name: string
  color: string
  cwd?: string
  nodes: SessionNodeInput[]
}

export type StatusKind = 'working' | 'attention' | 'done' | 'idle'

const STATE_LABEL: Record<StatusKind, string> = {
  working: 'Running',
  attention: 'Needs you',
  done: 'Done',
  idle: 'Idle'
}

/**
 * Whether a project group is collapsed in the sessions sidebar. With `autoCollapse` (the
 * default, `settings.sidebarAutoCollapse`) the default keeps the active project expanded and
 * every other project collapsed (so the list stays uncluttered); with it off, every project
 * defaults to expanded and nothing changes on a project switch. An explicit user toggle,
 * recorded in `overrides` (true = collapsed, false = expanded), always wins over the default.
 */
export function isGroupCollapsed(
  overrides: Record<string, boolean>,
  projectId: string,
  isActive: boolean,
  autoCollapse = true
): boolean {
  if (projectId in overrides) return overrides[projectId]
  return autoCollapse ? !isActive : false
}

/** What a left-click on a project header in the sessions sidebar does. */
export type ProjectHeadAction = 'switch' | 'toggle-collapse'

/**
 * A project header's click does exactly ONE of two things, and never both.
 *
 * - An INACTIVE project **switches** to that project and leaves `overrides` alone. Touching
 *   collapse here would be dead-or-wrong under both settings: with `sidebarAutoCollapse` ON
 *   the sidebar's own effect wipes every override on the `activeProjectId` change, so any
 *   toggle written here is clobbered a tick later (and unnecessary — the newly active project
 *   is expanded by default); with it OFF, writing one would discard the user's explicit
 *   choice, contradicting the documented "off = switches never touch the user's choices".
 * - The ACTIVE project **toggles its own collapse** — the pre-existing behavior of the whole
 *   header, kept so the row has no dead zone. It sets a normal override, which is transient
 *   under auto-collapse (dropped at the next switch) and sticky without it, exactly like the
 *   chevron button.
 *
 * The chevron is the escape hatch either way: it toggles collapse on ANY row (it
 * stops propagation), so an inactive project can be peeked into without switching.
 */
export function projectHeadClickAction(isActive: boolean): ProjectHeadAction {
  return isActive ? 'toggle-collapse' : 'switch'
}

/**
 * Header badges for a project group: how many sessions need the user right now
 * (waiting/blocked), how many finished unseen, and how many are actively working right now.
 * Mirrors the row glyph's precedence — an attention session is never double-counted as unread,
 * and a working one isn't unread yet (a new turn is running; the old mark resurfaces when it ends).
 */
export function projectSignalCounts(group: SessionGroup): { attention: number; unread: number; working: number } {
  let attention = 0
  let unread = 0
  let working = 0
  for (const s of [...group.ungrouped, ...group.groups.flatMap((b) => b.sessions)]) {
    if (s.statusKind === 'attention') attention++
    else if (s.unread && s.statusKind !== 'working') unread++
    if (s.statusKind === 'working') working++
  }
  return { attention, unread, working }
}

export function sessionStatusKind(state: AgentNodeStatus['state']): StatusKind {
  switch (state) {
    case 'working':
      return 'working'
    case 'waiting':
    case 'blocked':
      return 'attention'
    case 'done':
      return 'done'
    default:
      return 'idle'
  }
}

/**
 * Resolves the Cmd/Ctrl+N project shortcut: N is 1-based, matches sidebar/store array order.
 * Only 1-9 are addressable — out of range (including an empty or short project list) is null,
 * a silent no-op at the call site rather than a wraparound or error.
 */
export function projectIdAtIndex(projects: { id: string }[], oneBasedIndex: number): string | null {
  if (oneBasedIndex < 1 || oneBasedIndex > 9) return null
  const project = projects[oneBasedIndex - 1]
  return project ? project.id : null
}

export interface SessionRowVM {
  id: string
  title: string
  color: string
  agentId?: AgentId
  isAgent: boolean
  statusKind: StatusKind
  stateLabel: string
  unread: boolean
  session?: string
  loop?: { kind: 'loop' | 'schedule' | 'cron'; count: number }
  cwd?: string
  sshHost?: string
  sessionId?: string
  usesContext: boolean
}

/** A canvas group frame and the sessions nested inside it. */
export interface GroupBucket {
  id: string
  title: string
  color: string
  sessions: SessionRowVM[]
}

export interface SessionGroup {
  projectId: string
  projectName: string
  projectColor: string
  cwd?: string
  isActive: boolean
  /** Canvas group frames in this project, each with its member sessions. */
  groups: GroupBucket[]
  /** Sessions not inside any canvas group. */
  ungrouped: SessionRowVM[]
}

function toRow(n: SessionNodeInput, status: AgentNodeStatus | undefined): SessionRowVM {
  const statusKind = sessionStatusKind(status?.state)
  return {
    id: n.id,
    title: n.title,
    color: n.color,
    agentId: n.agentId,
    isAgent: !!n.agentId,
    statusKind,
    stateLabel: STATE_LABEL[statusKind],
    unread: !!status?.unread,
    session: status?.session,
    // A dismissed cron/schedule entry is retained as a fact (the hibernation guard reads it) but
    // shows nowhere it did not show before — this chip included.
    loop:
      status?.loop && !status.loop.dismissed
        ? { kind: status.loop.kind, count: status.loop.count }
        : undefined,
    cwd: n.cwd,
    sshHost: n.ssh?.host,
    sessionId: status?.sessionId,
    usesContext: n.agentId ? hasUsage(n.agentId) : false
  }
}

function matches(row: SessionRowVM, needle: string): boolean {
  const hay = `${row.title} ${row.session ?? ''}`.toLowerCase()
  return hay.includes(needle)
}

export function buildSessionList(
  projects: ProjectInput[],
  liveActiveNodes: SessionNodeInput[] | null,
  activeProjectId: string,
  statusById: Record<string, AgentNodeStatus>,
  filter: string
): SessionGroup[] {
  const needle = filter.trim().toLowerCase()
  const keep = (r: SessionRowVM): boolean => !needle || matches(r, needle)

  const groups: SessionGroup[] = projects.map((p) => {
    const isActive = p.id === activeProjectId
    const source = isActive && liveActiveNodes ? liveActiveNodes : p.nodes
    const groupNodes = source.filter((n) => n.kind === 'group')
    const groupIds = new Set(groupNodes.map((n) => n.id))
    const terminals = source.filter((n) => n.kind === 'terminal')

    const buckets: GroupBucket[] = groupNodes.map((gn) => ({
      id: gn.id,
      title: gn.title,
      color: gn.color,
      sessions: terminals
        .filter((n) => n.parentId === gn.id)
        .map((n) => toRow(n, statusById[n.id]))
        .filter(keep)
    }))

    const ungrouped = terminals
      .filter((n) => !n.parentId || !groupIds.has(n.parentId))
      .map((n) => toRow(n, statusById[n.id]))
      .filter(keep)

    return {
      projectId: p.id,
      projectName: p.name,
      projectColor: p.color,
      cwd: p.cwd,
      isActive,
      // When filtering, hide groups whose sessions all filtered out; otherwise keep empty
      // groups so they remain visible drop targets.
      groups: needle ? buckets.filter((b) => b.sessions.length > 0) : buckets,
      ungrouped
    }
  })

  // Store order, NOT active-first: the sidebar mirrors the tab bar (both read the projects
  // array), and hoisting the active project to the top made every click reshuffle the list.
  return needle ? groups.filter((g) => g.groups.length > 0 || g.ungrouped.length > 0) : groups
}
