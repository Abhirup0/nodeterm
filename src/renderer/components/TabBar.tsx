import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjects } from '../state/projects'

interface TabBarProps {
  onSwitch: (id: string) => void
  onAdd: () => void
  onAddFromFolder: () => void
  onRename: (id: string, name: string) => void
  onSetFolder: (id: string) => void
  onDelete: (id: string) => void
}

/**
 * Top tab bar — one tab per project. Click to switch, "+" to add. The active tab
 * exposes a caret menu (Rename / Set folder / Delete). The menu is rendered in a body
 * portal with fixed positioning so it is never clipped by the tab strip's overflow nor
 * hidden behind the canvas.
 */
export function TabBar({
  onSwitch,
  onAdd,
  onAddFromFolder,
  onRename,
  onSetFolder,
  onDelete
}: TabBarProps) {
  const projects = useProjects((s) => s.projects)
  const activeId = useProjects((s) => s.activeProjectId)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [addPos, setAddPos] = useState<{ top: number; left: number } | null>(null)
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
        <span className="tabbar__brand">node-terminal</span>

        <div className="tabbar__tabs">
          {projects.map((p) => {
            const active = p.id === activeId
            return (
              <div
                key={p.id}
                className={`tab${active ? ' active' : ''}`}
                style={active ? { borderBottomColor: p.color } : undefined}
                onClick={() => !editingId && onSwitch(p.id)}
                title={p.cwd || undefined}
              >
                <span className="tab__dot" style={{ background: p.color }} />
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

          <button
            className="tab__add"
            title="New project"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setAddPos({ top: r.bottom + 4, left: r.left })
            }}
          >
            +
          </button>
        </div>
      </div>

      {addPos &&
        createPortal(
          <>
            <div className="tab-backdrop" onClick={() => setAddPos(null)} />
            <div
              className="tab-menu"
              style={{ top: addPos.top, left: addPos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  onAdd()
                  setAddPos(null)
                }}
              >
                Empty project
              </button>
              <button
                onClick={() => {
                  onAddFromFolder()
                  setAddPos(null)
                }}
              >
                From folder…
              </button>
            </div>
          </>,
          document.body
        )}

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
              className="danger"
              disabled={projects.length <= 1}
              onClick={() => {
                onDelete(menuProject.id)
                closeMenu()
              }}
            >
              Delete project
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
