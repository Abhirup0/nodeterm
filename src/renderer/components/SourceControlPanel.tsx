import { Fragment, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitFileChange, GitResult, GitStatus } from '@shared/types'
import { useProjects } from '../state/projects'

interface SourceControlPanelProps {
  onClose: () => void
}

const STATUS_COLOR: Record<string, string> = {
  M: '#ffd60a',
  A: '#32d74b',
  D: '#ff453a',
  R: '#bf5af2',
  U: '#6ac4dc'
}

function DiffStat({ added, deleted }: { added: number; deleted: number }) {
  if (!added && !deleted) return null
  return (
    <span className="scm-stat">
      {added > 0 && <span className="scm-add">+{added}</span>}
      {deleted > 0 && <span className="scm-del">-{deleted}</span>}
    </span>
  )
}

/** Renders a unified diff with colored add/remove/hunk lines. */
function DiffBlock({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="scm-diff">
      {lines.map((ln, i) => {
        let cls = 'd-ctx'
        if (ln.startsWith('@@')) cls = 'd-hunk'
        else if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'd-add'
        else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'd-del'
        else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---'))
          cls = 'd-meta'
        return (
          <div key={i} className={cls}>
            {ln || ' '}
          </div>
        )
      })}
    </pre>
  )
}

/** Visual Studio-style Source Control: file-level stage/diff/discard + branch switcher. */
export function SourceControlPanel({ onClose }: SourceControlPanelProps) {
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const cwd = project?.cwd
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [diffText, setDiffText] = useState('')
  const [branchMenu, setBranchMenu] = useState<{ top: number; left: number } | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [generating, setGenerating] = useState(false)

  const git = window.nodeTerminal.git

  const refresh = useCallback(async () => {
    setStatus(cwd ? await git.status(cwd) : null)
  }, [cwd, git])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (fn: () => Promise<GitResult>) => {
    setBusy(true)
    const r = await fn()
    setError(r.ok ? '' : r.message)
    setBusy(false)
    setOpenKey(null)
    await refresh()
  }

  const toggleDiff = async (f: GitFileChange, staged: boolean) => {
    const key = `${staged ? 's' : 'c'}:${f.path}`
    if (openKey === key) {
      setOpenKey(null)
      return
    }
    setOpenKey(key)
    setDiffText('Loading…')
    const d = await git.diff(cwd!, f.path, staged, f.status === 'U')
    setDiffText(d || '(no textual diff)')
  }

  const discard = (f: GitFileChange) => {
    if (!window.confirm(`Discard changes to ${f.path}? This cannot be undone.`)) return
    void act(() => git.discard(cwd!, f.path, f.status === 'U'))
  }

  const generate = async () => {
    setGenerating(true)
    setError('')
    const r = await git.generateMessage(cwd!)
    setGenerating(false)
    if (r.ok) setMessage(r.message)
    else setError(r.message)
  }

  const commitAndPush = () =>
    act(async () => {
      const c = await git.commit(cwd!, message)
      if (!c.ok) return c
      setMessage('')
      return status?.hasRemote ? git.push(cwd!) : c
    })

  const renderFiles = (list: GitFileChange[], staged: boolean) =>
    list.map((f) => {
      const key = `${staged ? 's' : 'c'}:${f.path}`
      return (
        <Fragment key={key}>
          <div className={`scm-file${openKey === key ? ' open' : ''}`}>
            <span className="scm-letter" style={{ color: STATUS_COLOR[f.status] ?? 'rgba(255,255,255,0.85)' }}>
              {f.status}
            </span>
            <button className="scm-path" title={f.path} onClick={() => toggleDiff(f, staged)}>
              {f.path}
            </button>
            <DiffStat added={f.added} deleted={f.deleted} />
            <span className="scm-row-actions">
              {!staged && (
                <button className="scm-iconbtn" title="Discard changes" onClick={() => discard(f)}>
                  ↩
                </button>
              )}
              <button
                className="scm-iconbtn"
                title={staged ? 'Unstage' : 'Stage'}
                onClick={() =>
                  act(() => (staged ? git.unstage(cwd!, [f.path]) : git.stage(cwd!, [f.path])))
                }
              >
                {staged ? '−' : '+'}
              </button>
            </span>
          </div>
          {openKey === key && <DiffBlock text={diffText} />}
        </Fragment>
      )
    })

  const stagedCount = status?.staged.length ?? 0

  return createPortal(
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer scm" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <h2>Source control</h2>
          <button className="drawer__close" onClick={onClose}>
            ×
          </button>
        </div>

        {!cwd && (
          <div className="drawer__body">
            <p className="set-note">Set a folder for this project first (tab ⌄ → “Set folder…”).</p>
          </div>
        )}

        {cwd && status && !status.hasRepo && (
          <div className="drawer__body">
            <p className="set-note">No git repository in this folder.</p>
            <button className="sc-btn" disabled={busy} onClick={() => act(() => git.init(cwd))}>
              Initialize repository
            </button>
          </div>
        )}

        {cwd && status && status.hasRepo && (
          <>
            <div className="scm-bar">
              <span className="scm-repo">⌥ {status.repoName}</span>
              <button
                className="scm-branch"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setBranchMenu({ top: r.bottom + 4, left: r.left })
                }}
              >
                ⎇ {status.branch} ⌄
              </button>
              <span className="scm-spacer" />
              {status.hasRemote ? (
                <>
                  <span className="scm-ahead">↑{status.ahead}</span>
                  <span className="scm-behind">↓{status.behind}</span>
                  <button className="scm-sync" disabled={busy} onClick={() => act(() => git.sync(cwd))}>
                    Sync
                  </button>
                </>
              ) : (
                <button
                  className="scm-sync"
                  disabled={busy || !status.ghAvailable}
                  title={status.ghAvailable ? '' : 'GitHub CLI (gh) not found'}
                  onClick={() => act(() => git.publish(cwd, project?.name || 'repo', true))}
                >
                  Publish
                </button>
              )}
            </div>

            <div className="drawer__body scm-body">
              {status.staged.length > 0 && (
                <section className="scm-section">
                  <div className="scm-section-head">
                    <span>
                      STAGED · <b>{status.staged.length}</b>
                    </span>
                    <button onClick={() => act(() => git.unstageAll(cwd))}>unstage all</button>
                  </div>
                  {renderFiles(status.staged, true)}
                </section>
              )}

              <section className="scm-section">
                <div className="scm-section-head">
                  <span>
                    CHANGES · <b>{status.changes.length}</b>
                  </span>
                  {status.changes.length > 0 && (
                    <button onClick={() => act(() => git.stageAll(cwd))}>+ stage all</button>
                  )}
                </div>
                {status.changes.length === 0 && status.staged.length === 0 && (
                  <p className="set-note">No changes — working tree clean.</p>
                )}
                {renderFiles(status.changes, false)}
              </section>

              <section className="scm-commit">
                <div className="scm-commit-head">
                  <span>Commit message</span>
                  <button
                    className="scm-gen"
                    disabled={generating || stagedCount === 0}
                    title="Generate from staged diff with your AI agent"
                    onClick={generate}
                  >
                    {generating ? '✦ Generating…' : '✦ Generate'}
                  </button>
                </div>
                <textarea
                  className="scm-message"
                  placeholder="Message (⌘↵ to commit)"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitAndPush()
                  }}
                />
                <div className="scm-commit-foot">
                  <span>{stagedCount} files staged</span>
                  <span>⌘↵ to commit</span>
                </div>
                <button
                  className="scm-commit-btn"
                  disabled={busy || !message.trim() || stagedCount === 0}
                  onClick={commitAndPush}
                >
                  {status.hasRemote ? 'Commit & Push' : 'Commit'} → {status.branch}
                </button>
              </section>

              {status.recent.length > 0 && (
                <section className="scm-section">
                  <div className="scm-section-head">
                    <span>RECENT COMMITS</span>
                  </div>
                  {status.recent.map((c) => (
                    <div key={c.hash} className="scm-commit-row">
                      <span className="scm-hash">{c.hash}</span>
                      <span className="scm-subject" title={c.subject}>
                        {c.subject}
                      </span>
                      <span className="scm-rel">{c.relative}</span>
                    </div>
                  ))}
                </section>
              )}

              {error && <pre className="sc-log">{error}</pre>}
            </div>
          </>
        )}

        {branchMenu &&
          status &&
          createPortal(
            <>
              <div className="tab-backdrop" onClick={() => setBranchMenu(null)} />
              <div className="tab-menu" style={{ top: branchMenu.top, left: branchMenu.left }}>
                {status.branches.map((b) => (
                  <button
                    key={b}
                    onClick={() => {
                      setBranchMenu(null)
                      if (b !== status.branch) void act(() => git.switchBranch(cwd!, b))
                    }}
                  >
                    {b === status.branch ? '● ' : '   '}
                    {b}
                  </button>
                ))}
                <div className="ctx-sep" />
                <input
                  className="tab__edit"
                  placeholder="new branch name"
                  value={newBranch}
                  spellCheck={false}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newBranch.trim()) {
                      const name = newBranch.trim()
                      setNewBranch('')
                      setBranchMenu(null)
                      void act(() => git.createBranch(cwd!, name))
                    }
                  }}
                />
              </div>
            </>,
            document.body
          )}
      </aside>
    </div>,
    document.body
  )
}
