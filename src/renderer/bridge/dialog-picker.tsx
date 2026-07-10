// Web replacement for the Electron native folder/file dialog (Server Edition).
//
// The desktop build opens a native OS picker via the preload's `dialog` namespace; the browser
// build has no such thing. Instead we browse the *server's* filesystem in-app over `fs.list`
// (Task 4) and let the user drill into directories, then either "Use this folder" (folder mode)
// or click a file (file mode). The chosen ABSOLUTE path becomes a project cwd / opened file.
//
// `nextEntries` is the pure navigation core (unit-tested without the DOM). The modal, the
// `openDirectoryPicker` promise wrapper, and `mountPickerRoot` wire it into `ws-bridge`.

import { useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DirEntry } from '../../shared/types'

export type PickerMode = 'folder' | 'file'

/** A directory entry plus its resolved absolute path (the real `DirEntry` carries only a name). */
export type PickerRow = DirEntry & { path: string }

type ListFn = (dirPath: string) => Promise<DirEntry[]>

/** Strip a trailing slash from a path (but keep the root `/` as-is). */
function stripTrailingSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir
}

/** Join an absolute dir and a child name into an absolute path (no double slash at the root). */
function joinPath(dir: string, name: string): string {
  const base = stripTrailingSlash(dir)
  return base === '/' ? `/${name}` : `${base}/${name}`
}

/**
 * Pure navigation step: list `dir`, keep subdirectories (both modes) and — in `file` mode —
 * files too, resolve each row's absolute path, and compute the parent dir (`null` at the
 * filesystem root `/`). The modal calls this on every navigation.
 */
export async function nextEntries(
  dir: string,
  mode: PickerMode,
  list: ListFn
): Promise<{ parent: string | null; rows: PickerRow[] }> {
  const current = stripTrailingSlash(dir)
  const entries = await list(dir)
  const visible = mode === 'folder' ? entries.filter((e) => e.dir) : entries
  const rows: PickerRow[] = visible.map((e) => ({ ...e, path: joinPath(current, e.name) }))

  let parent: string | null = null
  if (current !== '/') {
    const cut = current.lastIndexOf('/')
    parent = cut <= 0 ? '/' : current.slice(0, cut)
  }
  return { parent, rows }
}

interface PickerProps {
  mode: PickerMode
  startDir: string
  list: ListFn
  onDone: (result: string | null) => void
}

function DirectoryPicker({ mode, startDir, list, onDone }: PickerProps): React.ReactElement {
  const [dir, setDir] = useState(startDir)
  const [rows, setRows] = useState<PickerRow[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    nextEntries(dir, mode, list)
      .then((view) => {
        if (cancelled) return
        setRows(view.rows)
        setParent(view.parent)
      })
      .catch(() => {
        if (!cancelled) setError('Could not read this folder')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dir, mode, list])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDone(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])

  const openRow = useCallback(
    (row: PickerRow) => {
      if (row.dir) setDir(row.path)
      else if (mode === 'file') onDone(row.path)
    },
    [mode, onDone]
  )

  return (
    <div className="confirm-overlay" onClick={() => onDone(null)}>
      <div
        className="confirm dir-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={mode === 'folder' ? 'Choose a folder' : 'Choose a file'}
      >
        <div className="dir-picker__head">
          <button
            className="dir-picker__up"
            onClick={() => parent && setDir(parent)}
            disabled={parent === null}
            title="Up one level"
          >
            ↑
          </button>
          <span className="dir-picker__path" title={dir}>
            {dir}
          </span>
        </div>

        <div className="dir-picker__list">
          {loading && <div className="dir-picker__empty">Loading…</div>}
          {!loading && error && <div className="dir-picker__empty">{error}</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="dir-picker__empty">
              {mode === 'folder' ? 'No subfolders here' : 'Empty folder'}
            </div>
          )}
          {!loading &&
            !error &&
            rows.map((row) => (
              <button
                key={row.path}
                className={`dir-picker__row${row.dir ? ' is-dir' : ''}`}
                onClick={() => openRow(row)}
              >
                <span className="dir-picker__icon">{row.dir ? '📁' : '📄'}</span>
                <span className="dir-picker__name">{row.name}</span>
              </button>
            ))}
        </div>

        <div className="confirm__actions">
          <button className="confirm__btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          {mode === 'folder' && (
            <button className="confirm__btn primary" onClick={() => onDone(stripTrailingSlash(dir))}>
              Use this folder
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Mount plumbing ──────────────────────────────────────────────────────────────────────────
let pickerRoot: Root | null = null

/** Create the React root container the picker renders into. Idempotent; call once from the bridge. */
export function mountPickerRoot(): void {
  if (pickerRoot || typeof document === 'undefined') return
  const container = document.createElement('div')
  container.id = 'nt-dialog-picker-root'
  document.body.appendChild(container)
  pickerRoot = createRoot(container)
}

/**
 * Open the in-app server-directory browser and resolve with the chosen ABSOLUTE path
 * (folder mode → the current dir; file mode → the clicked file) or `null` on cancel/close.
 * Never rejects — cancel resolves `null`, mirroring the native dialog's contract.
 */
export function openDirectoryPicker(opts: {
  mode: PickerMode
  startDir: string
  list: ListFn
}): Promise<string | null> {
  if (!pickerRoot) mountPickerRoot()
  return new Promise<string | null>((resolve) => {
    const finish = (result: string | null): void => {
      pickerRoot?.render(null)
      resolve(result)
    }
    pickerRoot?.render(
      <DirectoryPicker mode={opts.mode} startDir={opts.startDir} list={opts.list} onDone={finish} />
    )
  })
}
