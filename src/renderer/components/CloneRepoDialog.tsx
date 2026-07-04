import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  expandCloneUrl,
  isValidCloneUrl,
  deriveRepoDirName,
  type CloneProgress
} from '@shared/clone-url'

const PARENT_KEY = 'nodeterm.cloneParent'

interface CloneRepoDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the cloned absolute path + repo name; the caller opens the project. */
  onCloned: (path: string, name: string) => void
}

/**
 * REF-style clone dialog: URL (with owner/repo GitHub shorthand preview) + parent
 * folder (native picker, last-used remembered) + live progress + inline error.
 * Cancel — or closing the dialog — aborts the in-flight clone; main cleans up the
 * half-cloned directory it claimed.
 */
export function CloneRepoDialog({ open, onClose, onCloned }: CloneRepoDialogProps) {
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [cloning, setCloning] = useState(false)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [error, setError] = useState('')
  const urlRef = useRef<HTMLInputElement>(null)
  const cloningRef = useRef(false)

  const expanded = expandCloneUrl(url)
  const showPreview = url.trim() !== '' && expanded !== url.trim()
  const canClone = !cloning && parent.trim() !== '' && isValidCloneUrl(expanded)

  // Seed the parent dir once per open: last-used, else the main-suggested default.
  useEffect(() => {
    if (!open) return
    setError('')
    setProgress(null)
    urlRef.current?.focus()
    const remembered = localStorage.getItem(PARENT_KEY)
    if (remembered) setParent(remembered)
    else void window.nodeTerminal.git.cloneDefaultParent().then((p) => setParent((cur) => cur || p))
  }, [open])

  // Progress stream — subscribed only while the dialog is open.
  useEffect(() => {
    if (!open) return
    return window.nodeTerminal.git.onCloneProgress(setProgress)
  }, [open])

  // Closing the dialog (open → false) while a clone is in flight aborts it (main
  // deletes the claimed dir). The dialog is mounted unconditionally by Canvas, so this
  // fires on close, not unmount.
  useEffect(() => {
    cloningRef.current = cloning
  }, [cloning])
  useEffect(() => {
    if (open) return
    if (cloningRef.current) void window.nodeTerminal.git.cloneAbort()
  }, [open])

  if (!open) return null

  const startClone = async (): Promise<void> => {
    if (!canClone) return
    setCloning(true)
    setError('')
    setProgress(null)
    let r: Awaited<ReturnType<typeof window.nodeTerminal.git.clone>>
    try {
      r = await window.nodeTerminal.git.clone(parent.trim(), expanded)
    } catch (err) {
      setError(String(err))
      return
    } finally {
      setCloning(false)
    }
    if (!r.ok) {
      // Abort resolves message:'aborted' — the dialog is already closing; stay silent.
      if (r.message !== 'aborted') setError(r.message)
      return
    }
    localStorage.setItem(PARENT_KEY, parent.trim())
    const name = deriveRepoDirName(expanded) ?? 'repo'
    setUrl('')
    onCloned(r.message, name)
    onClose()
  }

  const cancel = (): void => {
    if (cloning) void window.nodeTerminal.git.cloneAbort()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void startClone()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return createPortal(
    <div className="confirm-overlay" onClick={cancel}>
      <div className="confirm clone-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">Clone repository</p>
        <label className="clone-dialog__label">Repository URL</label>
        <input
          ref={urlRef}
          className="confirm__input"
          value={url}
          placeholder="https://github.com/user/repo.git — or user/repo"
          spellCheck={false}
          disabled={cloning}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {showPreview && <div className="clone-dialog__preview">→ {expanded}</div>}
        <label className="clone-dialog__label">Parent folder</label>
        <div className="clone-dialog__row">
          <input
            className="confirm__input"
            value={parent}
            placeholder="/path/to/projects"
            spellCheck={false}
            disabled={cloning}
            onChange={(e) => setParent(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            className="confirm__btn"
            title="Choose folder"
            disabled={cloning}
            onClick={() => {
              void window.nodeTerminal.dialog.selectFolder().then((f) => {
                if (f) setParent(f)
              })
            }}
          >
            📁
          </button>
        </div>
        {error && <div className="clone-dialog__error">{error}</div>}
        {cloning && (
          <div className="clone-dialog__progress">
            <div className="clone-dialog__progress-label">
              {progress ? `${progress.phase}… ${progress.percent}%` : 'Starting clone…'}
            </div>
            <div className="clone-dialog__progress-track">
              <div
                className="clone-dialog__progress-bar"
                style={{ width: `${progress?.percent ?? 3}%` }}
              />
            </div>
          </div>
        )}
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={cancel}>
            Cancel
          </button>
          <button className="confirm__btn primary" disabled={!canClone} onClick={() => void startClone()}>
            {cloning ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
