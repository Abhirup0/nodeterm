import { useEffect, useMemo, useState } from 'react'
import { buildSessionList, type SessionNodeInput } from '../lib/sessionList'
import { SessionRow } from './SessionRow'
import { IconPin } from './icons'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'

const COLLAPSE_KEY = 'nodeterm.sessionsCollapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export interface SessionsSidebarProps {
  open: boolean
  pinned: boolean
  liveActiveNodes: SessionNodeInput[] | null
  onTogglePin(): void
  onClose(): void
  onFocusNode(id: string): void
  onCloseSession(projectId: string, id: string): void
  onRenameSession(projectId: string, id: string, title: string): void
  onRowContextMenu(e: React.MouseEvent, projectId: string, id: string): void
  onAddToProject(projectId: string): void
}

export function SessionsSidebar(props: SessionsSidebarProps): JSX.Element | null {
  const { open, pinned, liveActiveNodes } = props
  const projects = useProjects((s) => s.projects)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const statusById = useAgentStatus((s) => s.byId)

  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [branches, setBranches] = useState<Record<string, string>>({})

  // Look up the current git branch for each project cwd (best-effort, cached).
  useEffect(() => {
    let cancelled = false
    projects.forEach((p) => {
      if (!p.cwd || branches[p.id] !== undefined) return
      window.nodeTerminal.git
        .status(p.cwd)
        .then((st) => {
          if (!cancelled && st && typeof st.branch === 'string') {
            setBranches((b) => ({ ...b, [p.id]: st.branch }))
          }
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
  }, [projects, branches])

  const groups = useMemo(
    () => buildSessionList(projects, liveActiveNodes, activeProjectId, statusById, filter),
    [projects, liveActiveNodes, activeProjectId, statusById, filter]
  )

  const total = groups.reduce((n, g) => n + g.sessions.length, 0)

  const toggleCollapse = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      } catch {
        // ignore
      }
      return next
    })
  }

  if (!open) return null

  return (
    <aside className="sessions-sidebar" onMouseLeave={pinned ? undefined : props.onClose}>
      <div className="sessions-sidebar__head">
        <span className="sessions-sidebar__title">Sessions</span>
        <span className="sessions-sidebar__count">{total}</span>
        <div className="sessions-sidebar__head-actions">
          <button
            className={pinned ? 'is-on' : ''}
            title={pinned ? 'Unpin' : 'Pin'}
            onClick={props.onTogglePin}
          >
            <IconPin />
          </button>
          <button title="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="sessions-sidebar__search">
        <input
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="sessions-sidebar__body">
        {groups.length === 0 && <div className="sessions-sidebar__empty">No sessions yet.</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.projectId)
          return (
            <div key={g.projectId} className={`ss-group${g.isActive ? ' is-active' : ''}`}>
              <div className="ss-group__head" onClick={() => toggleCollapse(g.projectId)}>
                <span className="ss-group__chev">{isCollapsed ? '▶' : '▼'}</span>
                <span className="ss-group__dot" style={{ background: g.projectColor }} />
                <span className="ss-group__name">{g.projectName}</span>
                {branches[g.projectId] && (
                  <span className="ss-group__branch">⎇ {branches[g.projectId]}</span>
                )}
                <span className="ss-group__count">{g.sessions.length}</span>
                <button
                  className="ss-group__add"
                  title="New terminal in this project"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onAddToProject(g.projectId)
                  }}
                >
                  +
                </button>
              </div>
              {!isCollapsed &&
                (g.sessions.length === 0 ? (
                  <div className="ss-group__empty">No sessions</div>
                ) : (
                  g.sessions.map((row) => (
                    <SessionRow
                      key={row.id}
                      row={row}
                      onClick={() => props.onFocusNode(row.id)}
                      onClose={() => props.onCloseSession(g.projectId, row.id)}
                      onRename={(title) => props.onRenameSession(g.projectId, row.id, title)}
                      onContextMenu={(e) => props.onRowContextMenu(e, g.projectId, row.id)}
                    />
                  ))
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
