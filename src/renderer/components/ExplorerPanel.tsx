import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirEntry } from '@shared/types'
import { useProjects } from '../state/projects'

interface ExplorerPanelProps {
  onClose: () => void
  onOpenFile: (path: string) => void
}

type ContextFn = (x: number, y: number, path: string, isDir: boolean) => void
type OpenFn = (path: string) => void
type SelectFn = (path: string) => void

function EntryIcon({ dir }: { dir: boolean }) {
  return dir ? (
    <svg className="ex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ) : (
    <svg className="ex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  )
}

function TreeEntry({
  entry,
  path,
  depth,
  selected,
  onContext,
  onOpenFile,
  onSelect
}: {
  entry: DirEntry
  path: string
  depth: number
  selected: string | null
  onContext: ContextFn
  onOpenFile: OpenFn
  onSelect: SelectFn
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)

  const expandDir = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && children === null) setChildren(await window.nodeTerminal.fs.list(path))
  }, [open, children, path])

  // Files: first click selects, a second click (or double-click) opens the node.
  // Directories: a click toggles expansion (and selects for highlight).
  const onClick = useCallback(() => {
    if (entry.dir) {
      onSelect(path)
      void expandDir()
    } else if (selected === path) {
      onOpenFile(path)
    } else {
      onSelect(path)
    }
  }, [entry.dir, selected, path, onOpenFile, onSelect, expandDir])

  return (
    <>
      <div
        className={`ex-row${entry.ignored ? ' ignored' : ''}${selected === path ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        onDoubleClick={() => !entry.dir && onOpenFile(path)}
        onContextMenu={(e) => {
          e.preventDefault()
          onSelect(path)
          onContext(e.clientX, e.clientY, path, entry.dir)
        }}
        title={entry.name}
      >
        <span className={`ex-chevron${entry.dir ? '' : ' hidden'}${open ? ' open' : ''}`}>›</span>
        <EntryIcon dir={entry.dir} />
        <span className="ex-name">{entry.name}</span>
      </div>
      {entry.dir &&
        open &&
        children?.map((c) => (
          <TreeEntry
            key={c.name}
            entry={c}
            path={`${path}/${c.name}`}
            depth={depth + 1}
            selected={selected}
            onContext={onContext}
            onOpenFile={onOpenFile}
            onSelect={onSelect}
          />
        ))}
    </>
  )
}

/** Project file explorer — a lazy-loaded tree of the active project's folder.
 *
 * NOTE (Task 6): this Explorer is LOCAL-only. In a remote session the host's root cwd isn't known
 * client-side (the local project's `cwd` is the client's), so it can't be pointed at the host
 * filesystem yet. Once `canvas:state` carries the host cwd (Task 6), this can switch to
 * `remoteFs(connectionId)` (the per-connection `FsApi`) rooted at that path — the Editor already
 * proxies over the relay via `data.remote.connectionId`. */
export function ExplorerPanel({ onClose, onOpenFile }: ExplorerPanelProps) {
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const cwd = project?.cwd
  const [roots, setRoots] = useState<DirEntry[] | null>(null)
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  useEffect(() => {
    if (cwd) window.nodeTerminal.fs.list(cwd).then(setRoots)
    else setRoots(null)
  }, [cwd, version])

  const onContext: ContextFn = (x, y, path) => setMenu({ x, y, path })

  return createPortal(
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <h2>{project?.name || 'Explorer'}</h2>
          <div className="ex-head-actions">
            <button title="Refresh" onClick={() => setVersion((v) => v + 1)}>
              ↻
            </button>
            <button className="drawer__close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {!cwd && (
          <div className="drawer__body">
            <p className="set-note">Set a folder for this project first (tab ⌄ → “Set folder…”).</p>
          </div>
        )}

        {cwd && (
          <div className="drawer__body ex-body">
            {roots?.length === 0 && <p className="set-note">Empty folder.</p>}
            {roots?.map((e) => (
              <TreeEntry
                key={e.name}
                entry={e}
                path={`${cwd}/${e.name}`}
                depth={0}
                selected={selected}
                onContext={onContext}
                onOpenFile={onOpenFile}
                onSelect={setSelected}
              />
            ))}
          </div>
        )}
      </aside>

      {menu &&
        createPortal(
          <>
            <div className="tab-backdrop" style={{ zIndex: 78 }} onClick={() => setMenu(null)} />
            <div className="ctx-menu" style={{ top: menu.y, left: menu.x, zIndex: 80 }}>
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.clipboard.writeText(menu.path)
                  setMenu(null)
                }}
              >
                Copy Path
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.clipboard.writeText(cwd ? menu.path.slice(cwd.length + 1) : menu.path)
                  setMenu(null)
                }}
              >
                Copy Relative Path
              </button>
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.shell.reveal(menu.path)
                  setMenu(null)
                }}
              >
                Reveal in Finder
              </button>
            </div>
          </>,
          document.body
        )}
    </div>,
    document.body
  )
}
