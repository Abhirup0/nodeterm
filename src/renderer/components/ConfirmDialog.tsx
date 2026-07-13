import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { confirmKeyAction } from './confirm-key'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'

interface ConfirmDialogProps {
  message: string
  /** Optional content rendered ABOVE the message (e.g. the remote-access ConsentNotice), so the
   *  human reads what they are granting before the SAS body + buttons. */
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** An explicit opt-in shown above the buttons (e.g. "Delete the worktree directory from disk
   *  too"). The caller owns the value, so it can also swap the confirm label / danger styling. */
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  /**
   * May Enter confirm this dialog? Default true — the user asked for it. Pass FALSE for a dialog
   * the app raised on someone ELSE's behalf (an agent verb like `close-worktree`): the user never
   * asked for it, it appeared under their hands, and it must be answered by an explicit click.
   * Escape still cancels either way.
   */
  enterConfirms?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A small themed confirm dialog. Enter confirms and Esc cancels — but only under the conditions in
 * ./confirm-key, which exist because this listener is on `window` and therefore sees every key the
 * user aims at a terminal, a chat box or the command palette. Read that file before touching the
 * key handling: a stray Enter used to be able to delete a worktree.
 */
export function ConfirmDialog({
  message,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  option,
  enterConfirms = true,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  // One id per instance, for the lifetime of the component (mount order == paint order == stack).
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current
  const boxRef = useRef<HTMLDivElement>(null)
  // Set once, on the first render — not in an effect, so a key that arrives before the effect runs
  // is still measured against the moment the dialog appeared.
  const mountedAtRef = useRef(Date.now())

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = confirmKeyAction({
        key: e.key,
        repeat: e.repeat,
        // Not the dialog on top → this key is not ours (the topmost dialog's own listener still has
        // to see it, so we must not preventDefault it either).
        top: isTopDialog(id),
        // Aimed HERE, not at whatever had focus when we appeared. `boxRef` is the dialog box, so a
        // key typed into a terminal underneath the overlay can never answer it.
        inDialog: !!(e.target instanceof Node && boxRef.current?.contains(e.target)),
        sinceMount: Date.now() - mountedAtRef.current,
        enterConfirms
      })
      if (!action) return
      e.preventDefault()
      if (action === 'confirm') onConfirm()
      else onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, enterConfirms, onConfirm, onCancel])

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm" ref={boxRef} onClick={(e) => e.stopPropagation()}>
        {body}
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
          {/* The DESTRUCTIVE button never takes focus: autoFocus on it is what turned a stray Enter
              (or Space) into a deletion. On a danger dialog the safe button is the focused one; on a
              harmless one the primary action may keep it. */}
          <button className="confirm__btn" autoFocus={danger} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`confirm__btn${danger ? ' danger' : ' primary'}`}
            autoFocus={!danger}
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
