import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitFileChange, GitResult, GitStatus } from '@shared/types'
import { useProjects } from '../state/projects'

interface SourceControlPanelProps {
  onClose: () => void
  onRunInTerminal: (cmd: string) => void
  onOpenDiff: (relPath: string, staged: boolean) => void
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

/** Visual Studio-style Source Control: file-level stage/diff/discard + branch switcher. */
export function SourceControlPanel({
  onClose,
  onRunInTerminal,
  onOpenDiff
}: SourceControlPanelProps) {
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const cwd = project?.cwd
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [branchMenu, setBranchMenu] = useState<{ top: number; left: number } | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [generating, setGenerating] = useState(false)
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null)

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
    await refresh()
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
        <div
          key={key}
          className="scm-file"
          onContextMenu={(e) => {
            e.preventDefault()
            setFileMenu({ x: e.clientX, y: e.clientY, path: f.path })
          }}
        >
          <span className="scm-letter" style={{ color: STATUS_COLOR[f.status] ?? 'rgba(255,255,255,0.85)' }}>
            {f.status}
          </span>
          <button
            className="scm-path"
            title="Open diff"
            onClick={() => onOpenDiff(f.path, staged)}
          >
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
                  disabled={busy || !status.ghAuthed}
                  title={
                    !status.ghAvailable
                      ? 'GitHub CLI (gh) not found'
                      : !status.ghAuthed
                        ? 'Sign in to GitHub first'
                        : ''
                  }
                  onClick={() => act(() => git.publish(cwd, project?.name || 'repo', true))}
                >
                  Publish
                </button>
              )}
            </div>

            <div className="drawer__body scm-body">
              {status.ghAvailable && !status.ghAuthed && (
                <div className="scm-signin">
                  <span>Not signed in to GitHub.</span>
                  <button
                    onClick={() => {
                      onRunInTerminal('gh auth login')
                      onClose()
                    }}
                  >
                    Sign in to GitHub
                  </button>
                </div>
              )}

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
              <div
                className="tab-backdrop"
                style={{ zIndex: 78 }}
                onClick={() => setBranchMenu(null)}
              />
              <div
                className="tab-menu"
                style={{ top: branchMenu.top, left: branchMenu.left, zIndex: 80 }}
              >
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

      {fileMenu &&
        createPortal(
          <>
            <div className="tab-backdrop" style={{ zIndex: 78 }} onClick={() => setFileMenu(null)} />
            <div className="ctx-menu" style={{ top: fileMenu.y, left: fileMenu.x, zIndex: 80 }}>
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.clipboard.writeText(`${cwd}/${fileMenu.path}`)
                  setFileMenu(null)
                }}
              >
                Copy Path
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.clipboard.writeText(fileMenu.path)
                  setFileMenu(null)
                }}
              >
                Copy Relative Path
              </button>
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  window.nodeTerminal.shell.reveal(`${cwd}/${fileMenu.path}`)
                  setFileMenu(null)
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
