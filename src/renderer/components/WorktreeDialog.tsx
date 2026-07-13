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
  /** The repo's local branch names, offered as a dropdown for Base (and for the "existing branch"
   *  field). A ref can still be anything (a tag, a SHA, `origin/x`), so the field stays free-text —
   *  the list is a `<datalist>` of suggestions, not an exhaustive `<select>`. */
  branches: string[]
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
  branches,
  defaultPath,
  busy,
  error,
  onCreate,
  onBindExisting,
  onCancel
}: Props) {
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState('feature/')
  // `feature/` is a head-start for typing, not a submittable value — it fails `isValidGitRef`
  // (trailing slash). Showing the red "not a valid branch name" error on an untouched dialog reads
  // as the app yelling before the user has done anything, so the error waits until the field is
  // touched. (Create stays disabled meanwhile — see `valid` — so an unfinished `feature/` can't
  // slip through either way.)
  const [branchEdited, setBranchEdited] = useState(false)
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
  // Gate Create on the same validator the ops layer uses, so "clickable" always means "will not be
  // rejected for this reason" — the button reflects the REAL validity (so an untouched `feature/`
  // can't be submitted). The red error, by contrast, only appears once the user has touched the
  // field (`branchEdited`): a fresh dialog must not accuse the user of a bad name they never typed.
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

        {/* Local branch names offered to Base and to the "existing branch" field. A ref can still
            be any string (tag / SHA / origin/x), so these are datalist SUGGESTIONS, not a select. */}
        <datalist id="wt-branch-list">
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>

        <label className="bind-field">
          Branch
          {/* New branch = a name that must NOT exist yet (no suggestions). Existing branch = pick one
              that DOES exist, so offer the branch list there. */}
          <input
            value={branch}
            list={mode === 'existing' ? 'wt-branch-list' : undefined}
            onChange={(e) => {
              setBranch(e.target.value)
              setBranchEdited(true)
            }}
          />
        </label>

        {branchEdited && branchInvalid && (
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
              list="wt-branch-list"
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
