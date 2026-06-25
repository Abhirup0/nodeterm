import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export interface BindWorktreeValue {
  repoPath: string
  mode: 'new' | 'existing'
  branch: string
  baseRef: string
  path: string
}

interface Props {
  initialRepoPath: string
  /** Suggests an on-disk worktree path from the repo + branch. */
  defaultPath: (repoPath: string, branch: string) => string
  onConfirm: (v: BindWorktreeValue) => void
  onCancel: () => void
}

/** Modal to bind a group to a git worktree (new or existing branch). Esc cancels. */
export function BindWorktreeDialog({ initialRepoPath, defaultPath, onConfirm, onCancel }: Props) {
  const [repoPath, setRepoPath] = useState(initialRepoPath)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('feature/')
  const [baseRef, setBaseRef] = useState('main')
  const [path, setPath] = useState(() => defaultPath(initialRepoPath, 'feature/'))
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

  const valid = !!repoPath.trim() && !!branch.trim() && !!path.trim()

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm bind-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">Bind group to worktree</p>
        <label className="bind-field">
          Repo
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        </label>
        <div className="bind-mode">
          <label>
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New branch
          </label>
          <label>
            <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Existing branch
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
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="confirm__btn primary"
            disabled={!valid}
            onClick={() =>
              onConfirm({
                repoPath: repoPath.trim(),
                mode,
                branch: branch.trim(),
                baseRef: baseRef.trim(),
                path: path.trim()
              })
            }
          >
            Bind
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
