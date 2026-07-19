import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from '../dialog-stack'
import type { KanbanSession } from './KanbanView'

interface CardModalProps {
  session: KanbanSession
  /** Column title shown as a chip; null = Ungrouped. */
  columnTitle: string | null
  onClose: () => void
  /** Secondary action: close the modal, switch to canvas, focus the node. */
  onOpenCanvas: () => void
  /** Rename funnel (same as the sidebar's). */
  onRename: (title: string) => void
  /** Sticky text write-through (only called for kind 'sticky'). */
  onEditSticky: (text: string) => void
}

/** Trello-style card popup over the board. Scrim click / Esc close it; the board (and the
 *  canvas under it) stay mounted. Terminal pane arrives in Task 2 — until then terminal
 *  cards show the sticky/chat-style body with the open-on-canvas action. */
export function CardModal({ session, columnTitle, onClose, onOpenCanvas, onRename, onEditSticky }: CardModalProps) {
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(session.title)

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopDialog(id)) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Capture phase: beat the canvas/global keydown listeners to the Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [id, onClose])

  const commitTitle = () => {
    const t = title.trim()
    if (t && t !== session.title) onRename(t)
    setEditingTitle(false)
  }

  return createPortal(
    <div className="kanban-modal-scrim" onMouseDown={onClose}>
      {/* stopPropagation: clicks inside the sheet must not reach the scrim-close */}
      <div className="kanban-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="kanban-modal__header">
          <span className="kanban-card__nodedot" style={{ background: session.color }} />
          {editingTitle ? (
            <input
              className="kanban-modal__rename"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditingTitle(false)
                }
              }}
            />
          ) : (
            <span
              className="kanban-modal__title"
              onClick={() => {
                if (session.kind === 'sticky') return // a note's label IS its first line
                setTitle(session.title)
                setEditingTitle(true)
              }}
            >
              {session.title}
            </span>
          )}
          <span className="kanban-modal__column">{columnTitle ?? 'Ungrouped'}</span>
          <button className="kanban-modal__action" title="Open on canvas" onClick={onOpenCanvas}>
            ↗
          </button>
          <button className="kanban-modal__action" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="kanban-modal__body">
          {session.kind === 'sticky' ? (
            <textarea
              className="kanban-modal__sticky"
              value={session.text ?? ''}
              placeholder="Write a note…"
              onChange={(e) => onEditSticky(e.target.value)}
            />
          ) : (
            <div className="kanban-modal__pane" data-kind={session.kind}>
              {/* Task 2 replaces this with the live co-attach terminal for kind 'terminal'. */}
              <div className="kanban-modal__placeholder">
                {session.kind === 'chat' ? 'Chat sessions open on the canvas.' : 'Terminal'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
