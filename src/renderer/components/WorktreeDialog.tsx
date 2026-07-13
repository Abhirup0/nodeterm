import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { isValidGitRef, type WorktreeCreateValue, type WorktreeEntry } from '@shared/worktree'

interface Props {
  /** 'create' = the pane/palette entry point (a new group frame); 'bind' = an existing group's
   *  "Bind to worktree…". Only the wording differs — both can create or adopt a worktree. */
  intent: 'create' | 'bind'
  /** Repo root, resolved from the project cwd. Empty only when the project is not a git repo. */
  repoPath: string
  /** Worktrees that already exist for this repo, excluding the main checkout and bound ones. */
  existing: WorktreeEntry[]
  /** The repo's default branch (the main checkout's), used as the Base default. */
  defaultBaseRef: string
  /** Suggested worktree path. Returns '' when no writable base dir is known — see `pathUnknown`. */
  defaultPath: (repoPath: string, branch: string) => string
  busy: boolean
  error: string | null
  onCreate: (v: WorktreeCreateValue) => void
  onBindExisting: (e: WorktreeEntry) => void
  onCancel: () => void
}

/** Create a worktree (and the group frame around it), or bind a group to one that already exists. */
export function WorktreeDialog({
  intent,
  repoPath,
  existing,
  defaultBaseRef,
  defaultPath,
  busy,
  error,
  onCreate,
  onBindExisting,
  onCancel
}: Props) {
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('feature/')
  const [baseRef, setBaseRef] = useState(defaultBaseRef)
  const [path, setPath] = useState(() => defaultPath(repoPath, 'feature/'))
  const [pathEdited, setPathEdited] = useState(false)

  // Keep the path in sync with the branch until the user edits it by hand.
  useEffect(() => {
    if (!pathEdited) setPath(defaultPath(repoPath, branch || 'work'))
  }, [repoPath, branch, pathEdited, defaultPath])

  // The repo's default branch resolves asynchronously (the store fills after the first render);
  // adopt it as long as the user has not typed a base of their own.
  const [baseEdited, setBaseEdited] = useState(false)
  useEffect(() => {
    if (!baseEdited) setBaseRef(defaultBaseRef)
  }, [defaultBaseRef, baseEdited])

  // Only the topmost modal answers a key (./dialog-stack): this dialog and a ConfirmDialog can be
  // open at the same time, and one Escape must not close both.
  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onCancel])

  // No writable base dir is known, so we refuse to *suggest* a path — an empty base would
  // otherwise propose `/worktrees/…` at the filesystem root. The user can still type one. The hint
  // tracks the FIELD, not `pathEdited`: clearing the box after editing it also leaves Create
  // disabled, and a disabled button with no explanation is a dead end.
  const pathUnknown = !path.trim()
  // The default branch value ('feature/') is a STARTING POINT for typing, not a submittable one —
  // it fails `isValidGitRef` (trailing slash), so a fresh dialog must not let Create through: the
  // ops layer would reject it and the user would see "Invalid branch name." on the very first use
  // of the feature. Gate the button on the same validator the ops layer uses, so "clickable" always
  // means "will not be rejected for this reason." The hint only fires once the field is non-empty —
  // an untouched-but-empty field needs no explanation, `!valid` alone covers it.
  const branchInvalid = !!branch.trim() && !isValidGitRef(branch)
  const valid = !!repoPath.trim() && !!branch.trim() && !branchInvalid && !!path.trim() && !busy
  const title = intent === 'bind' ? 'Bind to worktree' : 'New worktree'
  const createLabel = intent === 'bind' ? 'Create & bind' : 'Create'

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm bind-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">{title}</p>

        <div className="bind-repo" title={repoPath}>
          {repoPath || 'This project is not a git repository.'}
        </div>

        {existing.length > 0 && (
          <div className="bind-existing">
            <div className="bind-existing__title">Existing worktrees</div>
            {existing.map((e) => (
              // A detached-HEAD worktree cannot be bound (there is no branch to merge or name the
              // group after), so the row is DISABLED and says why — clicking it used to be a
              // silent no-op.
              <button
                key={e.path}
                className="bind-existing__row"
                disabled={busy || !e.branch}
                onClick={() => onBindExisting(e)}
                title={
                  e.branch
                    ? e.path
                    : `${e.path}\nDetached HEAD — check out a branch in this worktree first.`
                }
              >
                <span className="bind-existing__branch">
                  {e.branch ? `⎇ ${e.branch}` : '⎇ (detached HEAD — check out a branch first)'}
                </span>
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

        {branchInvalid && (
          <div className="bind-error">
            Not a valid branch name — finish typing one (no spaces, "..", or a leading/trailing
            slash).
          </div>
        )}

        {mode === 'new' && (
          <label className="bind-field">
            Base
            <input
              value={baseRef}
              onChange={(e) => {
                setBaseRef(e.target.value)
                setBaseEdited(true)
              }}
            />
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

        {pathUnknown && (
          <div className="bind-error">
            No default worktree location is available. Enter a full path to create one.
          </div>
        )}
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
            {busy ? 'Creating…' : createLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
