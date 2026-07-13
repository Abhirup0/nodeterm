import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DirEntry, FsApi } from '@shared/types'
import { useProjects } from '../state/projects'
import { useExplorer } from '../state/explorer'
import { sshFs } from '../terminal/ssh-fs'
import { promptDialog } from './promptDialog'
import { ancestorDirs, createTargetDir, newEntryPath, parentDir } from '../lib/explorerCreate'

interface ExplorerPanelProps {
  onClose: () => void
  /** Open a file as an editor node. `sshFs` is true for SSH projects (the path is remote, read/
   *  written over the project's ControlMaster fs); false/omitted for local + relay projects. */
  onOpenFile: (path: string, sshFs?: boolean) => void
  /** File to reveal (expand ancestors + select + scroll). `path` is relative to the active project
   *  cwd; `nonce` increments per request so revealing the same file twice still re-fires. */
  reveal?: { path: string; nonce: number } | null
}

type ContextFn = (x: number, y: number, path: string, isDir: boolean) => void
type OpenFn = (path: string) => void
type SelectFn = (path: string) => void

// Surface a transient error message (matches the Canvas listener at Canvas.tsx:380).
const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

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
  fs,
  projectId,
  version,
  selected,
  onContext,
  onOpenFile,
  onSelect
}: {
  entry: DirEntry
  path: string
  depth: number
  fs: FsApi
  projectId: string
  version: number
  selected: string | null
  onContext: ContextFn
  onOpenFile: OpenFn
  onSelect: SelectFn
}) {
  const open = useExplorer((s) => (s.expandedByProject[projectId] ?? []).includes(path))
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  const toggleDir = useCallback(() => {
    useExplorer.getState().setExpanded(projectId, path, !open)
  }, [projectId, path, open])

  // A version bump (create/refresh) invalidates every cached subtree; open dirs re-list
  // through the children===null effect below. Initial mount is a no-op (ref seeded with the
  // current version), so a collapsed dir never fetches eagerly.
  const lastVersionRef = useRef(version)
  useEffect(() => {
    if (lastVersionRef.current === version) return
    lastVersionRef.current = version
    setChildren(null)
  }, [version])

  // Lazy-load children whenever this dir is (or becomes) open with nothing loaded yet —
  // covers click-to-expand, restored-from-storage, and reveal-forced expansion alike.
  useEffect(() => {
    if (!entry.dir || !open || children !== null) return
    let cancelled = false
    void fs.list(path).then((c) => {
      if (!cancelled) setChildren(c)
    })
    return () => {
      cancelled = true
    }
  }, [entry.dir, open, children, path, fs])

  // Reveal: scroll the selected (target) row into view once it has mounted.
  useEffect(() => {
    if (selected === path) rowRef.current?.scrollIntoView({ block: 'center' })
  }, [selected, path])

  // Files: first click selects, a second click (or double-click) opens the node.
  // Directories: a click toggles expansion (and selects for highlight).
  const onClick = useCallback(() => {
    if (entry.dir) {
      onSelect(path)
      toggleDir()
    } else if (selected === path) {
      onOpenFile(path)
    } else {
      onSelect(path)
    }
  }, [entry.dir, selected, path, onOpenFile, onSelect, toggleDir])

  return (
    <>
      <div
        ref={rowRef}
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
            fs={fs}
            projectId={projectId}
            version={version}
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
 * SSH projects browse the REMOTE filesystem (rooted at `project.ssh.remoteCwd`, listed via
 * `sshFs(projectId)` over the ControlMaster); local projects use the local fs rooted at `cwd`.
 *
 * NOTE (relay, Task 6): the RELAY path is still local-only — in a relay session the host's root cwd
 * isn't known client-side (the local project's `cwd` is the client's). Once `canvas:state` carries
 * the host cwd, this can also switch to `remoteFs(connectionId)` for relay projects (the Editor
 * already proxies over the relay via `data.remote.connectionId`). */
export function ExplorerPanel({ onClose, onOpenFile, reveal }: ExplorerPanelProps) {
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId))
  // SSH projects browse the REMOTE filesystem: root at the project's `remoteCwd` and list over the
  // ControlMaster via `sshFs`. Local (and relay) projects keep the local fs rooted at `cwd`.
  const ssh = project?.ssh
  const cwd = ssh ? ssh.remoteCwd : project?.cwd
  const fs = useMemo<FsApi>(
    () => (ssh && project ? sshFs(project.id) : window.nodeTerminal.fs),
    [project?.id, ssh]
  )
  // Files opened from an SSH project's Explorer are genuinely remote — stamp `sshFs` so the editor
  // node routes its read/write over the project's ControlMaster fs (local/relay projects pass false).
  const handleOpenFile = useCallback<OpenFn>((path) => onOpenFile(path, !!ssh), [onOpenFile, ssh])
  const [roots, setRoots] = useState<DirEntry[] | null>(null)
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null)

  useEffect(() => {
    if (cwd) fs.list(cwd).then(setRoots)
    else setRoots(null)
  }, [cwd, version, fs])

  // Reveal a file: force-open every ancestor directory under cwd, select the file, and
  // let the matching row scroll itself into view. Only paths inside cwd are revealed.
  // Keyed on the nonce so revealing the same file twice still re-triggers.
  useEffect(() => {
    const revealPath = reveal?.path
    if (!revealPath || !cwd) return
    const base = cwd.replace(/\/$/, '')
    const rel = revealPath.startsWith(base + '/') ? revealPath.slice(base.length + 1) : revealPath
    // Reject paths that escape cwd (absolute outside it, or "../" traversal).
    if (rel.startsWith('/') || rel.split('/').includes('..')) return
    const abs = `${base}/${rel}`
    const parts = rel.split('/')
    const dirs = new Set<string>()
    let acc = base
    for (let i = 0; i < parts.length - 1; i++) {
      acc = `${acc}/${parts[i]}`
      dirs.add(acc)
    }
    useExplorer.getState().expandMany(project!.id, [...dirs])
    setSelected(abs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, cwd])

  const onContext: ContextFn = (x, y, path, isDir) => setMenu({ x, y, path, dir: isDir })

  // Create a file or folder under the clicked entry (a dir targets itself, a file its
  // parent). Multi-segment names create intermediate dirs. Never overwrites: an existing
  // path is surfaced as a toast and the prompt is abandoned.
  const createEntry = useCallback(
    async (targetPath: string, targetIsDir: boolean, kind: 'file' | 'folder') => {
      const baseDir = createTargetDir(targetPath, targetIsDir)
      const name = await promptDialog({
        message: kind === 'file' ? 'New file name:' : 'New folder name:',
        placeholder: kind === 'file' ? 'notes.md (subdirs ok: docs/notes.md)' : 'folder name',
        confirmLabel: 'Create'
      })
      if (name === null) return
      const dest = newEntryPath(baseDir, name)
      if (!dest) {
        toast(`Invalid name: “${name.trim()}”`)
        return
      }
      if (await fs.exists(dest)) {
        toast(`Already exists: ${dest}`)
        return
      }
      const ok =
        kind === 'folder'
          ? await fs.mkdir(dest)
          : (name.includes('/') ? await fs.mkdir(parentDir(dest)) : true) && (await fs.write(dest, ''))
      if (!ok) {
        toast(`Could not create ${dest}`)
        return
      }
      // Keep the target (and any new intermediate dirs) expanded, then re-list the tree.
      if (project) {
        const dirs = [baseDir, ...ancestorDirs(baseDir, name)].filter((d) => d !== cwd)
        useExplorer.getState().expandMany(project.id, dirs)
      }
      setVersion((v) => v + 1)
      if (kind === 'file') handleOpenFile(dest)
    },
    [fs, cwd, project, handleOpenFile]
  )

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
          <div
            className="drawer__body ex-body"
            onContextMenu={(e) => {
              if (e.target !== e.currentTarget || !cwd) return
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, path: cwd, dir: true })
            }}
          >
            {roots?.length === 0 && <p className="set-note">Empty folder.</p>}
            {roots?.map((e) => (
              <TreeEntry
                key={e.name}
                entry={e}
                path={`${cwd}/${e.name}`}
                depth={0}
                fs={fs}
                projectId={project!.id}
                version={version}
                selected={selected}
                onContext={onContext}
                onOpenFile={handleOpenFile}
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
                  const m = menu
                  setMenu(null)
                  void createEntry(m.path, m.dir, 'file')
                }}
              >
                New File…
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  const m = menu
                  setMenu(null)
                  void createEntry(m.path, m.dir, 'folder')
                }}
              >
                New Folder…
              </button>
              <div className="ctx-sep" />
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
