import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorktreeEntry } from '@shared/worktree'

export interface WorktreeCreateValue {
  repoPath: string
  mode: 'new' | 'existing'
  branch: string
  baseRef: string
  path: string
}

interface Props {
  /** Repo root, resolved from the project cwd. Empty only when the project is not a git repo. */
  repoPath: string
  /** Worktrees that already exist for this repo, excluding the main checkout. */
  existing: WorktreeEntry[]
  defaultPath: (repoPath: string, branch: string) => string
  busy: boolean
  error: string | null
  onCreate: (v: WorktreeCreateValue) => void
  onBindExisting: (e: WorktreeEntry) => void
  onCancel: () => void
}

/** Create a worktree (and the group frame around it), or bind a group to one that already exists. */
export function WorktreeDialog({
  repoPath,
  existing,
  defaultPath,
  busy,
  error,
  onCreate,
  onBindExisting,
  onCancel
}: Props) {
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('feature/')
  const [baseRef, setBaseRef] = useState('main')
  const [path, setPath] = useState(() => defaultPath(repoPath, 'feature/'))
  const [pathEdited, setPathEdited] = useState(false)

  // Keep the path in sync with the branch until the user edits it by hand.
  useEffect(() => {
    if (!pathEdited) setPath(defaultPath(repoPath, branch || 'work'))
  }, [repoPath, branch, pathEdited, defaultPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const valid = !!repoPath.trim() && !!branch.trim() && !!path.trim() && !busy

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm bind-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">New worktree</p>

        <div className="bind-repo" title={repoPath}>
          {repoPath || 'This project is not a git repository.'}
        </div>

        {existing.length > 0 && (
          <div className="bind-existing">
            <div className="bind-existing__title">Existing worktrees</div>
            {existing.map((e) => (
              <button
                key={e.path}
                className="bind-existing__row"
                disabled={busy}
                onClick={() => onBindExisting(e)}
                title={e.path}
              >
                <span className="bind-existing__branch">⎇ {e.branch ?? '(detached)'}</span>
                <span className="bind-existing__path">{e.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="bind-mode">
          <label>
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New branch
          </label>
          <label>
            <input
              type="radio"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
            />{' '}
            Existing branch
          </label>
        </div>

        <label className="bind-field">
          Branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>

        {mode === 'new' && (
          <label className="bind-field">
            Base
            <input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
          </label>
        )}

        <label className="bind-field">
          Worktree path
          <input
            value={path}
            onChange={(e) => {
              setPath(e.target.value)
              setPathEdited(true)
            }}
          />
        </label>

        {error && <div className="bind-error">{error}</div>}

        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="confirm__btn primary"
            disabled={!valid}
            onClick={() =>
              onCreate({
                repoPath: repoPath.trim(),
                mode,
                branch: branch.trim(),
                baseRef: baseRef.trim(),
                path: path.trim()
              })
            }
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
