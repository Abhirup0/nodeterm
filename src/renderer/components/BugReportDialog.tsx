import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { BODY_BUDGET, buildBugReportUrl, envBlock, type BugReportEnv } from '../lib/bugReport'

interface BugReportDialogProps {
  env: BugReportEnv
  /** Receives the composed issues/new URL; the caller opens it (shell.openExternal). */
  onOpen: (url: string) => void
  onClose: () => void
}

/**
 * "Report a bug" — composes a prefilled GitHub issue and hands the URL to the caller.
 * A prefilled URL cannot carry attachments, hence the paste-on-GitHub note; the env
 * block preview shows exactly what gets appended to the body.
 */
export function BugReportDialog({ env, onOpen, onClose }: BugReportDialogProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  useDialogStack()

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const willTruncate = description.length > BODY_BUDGET - 200
  const canSubmit = title.trim().length > 0

  const submit = () => {
    if (!canSubmit) return
    const { url } = buildBugReportUrl(title.trim(), description, env)
    onOpen(url)
    onClose()
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div
        className="confirm bug-report"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <p className="confirm__msg">Report a bug</p>
        <input
          ref={titleRef}
          className="confirm__input"
          value={title}
          placeholder="Short summary of the problem"
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <textarea
          className="confirm__input bug-report__desc"
          value={description}
          placeholder={'What did you do?\nWhat did you expect?\nWhat happened instead?'}
          spellCheck={false}
          onChange={(e) => setDescription(e.target.value)}
        />
        <pre className="bug-report__env">{envBlock(env)}</pre>
        <p className="bug-report__note">
          Opens a prefilled issue on GitHub — you submit it from your own account. Screenshots or
          logs can be pasted there.
          {willTruncate ? ' Long descriptions are truncated to fit the URL.' : ''}
        </p>
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onClose}>
            Cancel
          </button>
          <button className="confirm__btn primary" disabled={!canSubmit} onClick={submit}>
            Open on GitHub
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
