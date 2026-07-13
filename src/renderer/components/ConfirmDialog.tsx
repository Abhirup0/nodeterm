import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'

interface ConfirmDialogProps {
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** An explicit opt-in shown above the buttons (e.g. "Delete the worktree directory from disk
   *  too"). The caller owns the value, so it can also swap the confirm label / danger styling. */
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A small themed confirm dialog. Enter confirms, Esc cancels — but ONLY while this dialog is the
 * topmost one (see ./dialog-stack): the listener is on `window`, and a dialog painted underneath
 * another must never answer a key the user aimed at the one they can see.
 */
export function ConfirmDialog({
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  option,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  // One id per instance, for the lifetime of the component (mount order == paint order == stack).
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not the dialog on top → this key is not ours. Do not preventDefault either: the topmost
      // dialog's own listener still has to see it.
      if (!isTopDialog(id)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, onConfirm, onCancel])

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">{message}</p>
        {option && (
          <label className="confirm__option">
            <input
              type="checkbox"
              checked={option.checked}
              onChange={(e) => option.onChange(e.target.checked)}
            />
            {option.label}
          </label>
        )}
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`confirm__btn${danger ? ' danger' : ' primary'}`}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
