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
 * Whether a project group is collapsed in the sessions sidebar. The default keeps the active
 * project expanded and every other project collapsed (so the list stays uncluttered); an
 * explicit user toggle, recorded in `overrides` (true = collapsed, false = expanded), wins
 * over that default.
 */
export function isGroupCollapsed(
  overrides: Record<string, boolean>,
  projectId: string,
  isActive: boolean
): boolean {
  return projectId in overrides ? overrides[projectId] : !isActive
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

export interface SessionGroup {
  projectId: string
  projectName: string
  projectColor: string
  cwd?: string
  isActive: boolean
  sessions: SessionRowVM[]
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
    loop: status?.loop ? { kind: status.loop.kind, count: status.loop.count } : undefined,
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
  const groups: SessionGroup[] = projects.map((p) => {
    const isActive = p.id === activeProjectId
    const source = isActive && liveActiveNodes ? liveActiveNodes : p.nodes
    let sessions = source
      .filter((n) => n.kind === 'terminal')
      .map((n) => toRow(n, statusById[n.id]))
    if (needle) sessions = sessions.filter((r) => matches(r, needle))
    return {
      projectId: p.id,
      projectName: p.name,
      projectColor: p.color,
      cwd: p.cwd,
      isActive,
      sessions
    }
  })

  const ordered = [
    ...groups.filter((g) => g.isActive),
    ...groups.filter((g) => !g.isActive)
  ]
  return needle ? ordered.filter((g) => g.sessions.length > 0) : ordered
}
