import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'

interface TabBarProps {
  onSwitch: (id: string) => void
  /** Open the start screen (New project / Open folder / Clone repo) — what "+" now shows. */
  onOpenWelcome: () => void
  onRename: (id: string, name: string) => void
  onSetFolder: (id: string) => void
  /** Close (hide) the project without destroying it — reopenable from the start screen. */
  onCloseProject: (id: string) => void
  /** Open the Remote access dialog (host/share + connect). Shown for every project. */
  onRemoteAccess: () => void
}

/**
 * Top tab bar — one tab per project. Click to switch, "+" to add. The active tab
 * exposes a caret menu (Rename / Set folder / Delete). The menu is rendered in a body
 * portal with fixed positioning so it is never clipped by the tab strip's overflow nor
 * hidden behind the canvas.
 */
export function TabBar({
  onSwitch,
  onOpenWelcome,
  onRename,
  onSetFolder,
  onCloseProject,
  onRemoteAccess
}: TabBarProps) {
  // Select the raw array and filter in a memo — a `.filter()` inside the selector returns a
  // fresh array every store snapshot, which re-rendered the TabBar on EVERY projects change.
  const allProjects = useProjects((s) => s.projects)
  // Closed projects are hidden here (reopen them from the start screen's "Recently closed").
  const projects = useMemo(() => allProjects.filter((p) => !p.closed), [allProjects])
  const activeId = useProjects((s) => s.activeProjectId)
  // Unread dots need only the unread id set — subscribing to the whole status map re-rendered
  // the TabBar on every working/waiting flip of any agent. Primitive signature → rare updates.
  const unreadIds = useAgentStatus((s) => {
    let ids = ''
    for (const [id, st] of Object.entries(s.byId)) if (st?.unread) ids += `${id}|`
    return ids
  })
  const unreadSet = useMemo(() => new Set(unreadIds.split('|').filter(Boolean)), [unreadIds])
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const menuProject = projects.find((p) => p.id === menuId)

  const closeMenu = () => {
    setMenuId(null)
    setMenuPos(null)
  }

  const openMenu = (id: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect()
    setMenuId(id)
    setMenuPos({ top: r.bottom + 4, left: r.left })
  }

  const startRename = (id: string, current: string) => {
    setEditingId(id)
    setDraft(current)
    closeMenu()
  }

  const commitRename = () => {
    if (editingId) {
      const name = draft.trim()
      if (name) onRename(editingId, name)
    }
    setEditingId(null)
  }

  return (
    <>
      {(menuId || editingId) && (
        <div
          className="tab-backdrop"
          onClick={() => {
            closeMenu()
            commitRename()
          }}
        />
      )}

      <div className="tabbar">
        <div className="brand">
          <svg className="brand__mark" viewBox="0 0 48 48" width="26" height="26" aria-hidden="true">
            <defs>
              <linearGradient id="ntg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#a38dff" />
                <stop offset="1" stopColor="#622994" />
              </linearGradient>
            </defs>
            <path
              d="M13 12 L31 24 L13 36"
              fill="none"
              stroke="url(#ntg)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="13" cy="12" r="3.6" fill="#a38dff" />
            <circle cx="13" cy="36" r="3.6" fill="#a38dff" />
            <circle cx="31" cy="24" r="3.6" fill="#fff" />
            <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff" />
          </svg>
          <span className="brand__name">nodeterm</span>
        </div>

        <div className="tabbar__tabs">
          {projects.map((p) => {
            const active = p.id === activeId
            const unreadCount = p.nodes.filter((n) => unreadSet.has(n.id)).length
            return (
              <div
                key={p.id}
                className={`tab${active ? ' active' : ''}`}
                style={active ? { color: p.color } : undefined}
                onClick={() => !editingId && onSwitch(p.id)}
                title={p.cwd || undefined}
              >
                <span
                  className="tab__dot"
                  style={active ? { background: p.color } : undefined}
                />
                {editingId === p.id ? (
                  <input
                    className="tab__edit"
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="tab__name">{p.name}</span>
                )}

                {unreadCount > 0 && (
                  <span className="tab__badge" title={`${unreadCount} unread`}>
                    {unreadCount}
                  </span>
                )}

                {active && editingId !== p.id && (
                  <button
                    className="tab__caret"
                    title="Project options"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (menuId === p.id) closeMenu()
                      else openMenu(p.id, e.currentTarget)
                    }}
                  >
                    ⌄
                  </button>
                )}
              </div>
            )
          })}

          <button className="tab__add" title="New project" onClick={onOpenWelcome}>
            +
          </button>
        </div>
      </div>

      {menuId &&
        menuPos &&
        menuProject &&
        createPortal(
          <div
            className="tab-menu"
            style={{ top: menuPos.top, left: menuPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => startRename(menuProject.id, menuProject.name)}>Rename</button>
            <button
              onClick={() => {
                onSetFolder(menuProject.id)
                closeMenu()
              }}
            >
              Set folder…
            </button>
            <button
              onClick={() => {
                onRemoteAccess()
                closeMenu()
              }}
            >
              Remote access…
            </button>
            <button
              onClick={() => {
                onCloseProject(menuProject.id)
                closeMenu()
              }}
            >
              Close project
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
