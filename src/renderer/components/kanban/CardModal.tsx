import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from '../dialog-stack'
import { IconChat, IconMic, IconSearch } from '../icons'
import { useSession } from '../../session/session'
import type { KanbanSession } from './KanbanView'
import { BoardLogPanel } from './BoardLogPanel'
import { ModalTerminal } from './ModalTerminal'

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
 *  canvas under it) stay mounted. Terminal cards carry the node header's actions too:
 *  search / dictate / AI-name / markdown view (the node itself is hidden under the board). */
export function CardModal({ session, columnTitle, onClose, onOpenCanvas, onRename, onEditSticky }: CardModalProps) {
  const { api } = useSession()
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [searchOpen, setSearchOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  // Comments & activity panel: OPEN by default in the modal; the header 💬 collapses it.
  const [panelOpen, setPanelOpen] = useState(true)
  const isTerminal = session.kind === 'terminal'

  const nameWithAi = async () => {
    setNaming(true)
    const r = await api.pty.generateName(session.id, session.spawn.cwd ?? '')
    setNaming(false)
    if (r.ok) onRename(r.message)
  }
  // Ref mirror: the capture-phase listener below closes over stale state otherwise.
  const editingTitleRef = useRef(false)
  useEffect(() => {
    editingTitleRef.current = editingTitle
  }, [editingTitle])

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopDialog(id)) return
      e.preventDefault()
      e.stopPropagation()
      if (editingTitleRef.current) {
        // Esc during a rename cancels the EDIT, not the modal.
        setEditingTitle(false)
        return
      }
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
                // Esc is owned by the capture-phase handler (cancels the edit).
                if (e.key === 'Enter') commitTitle()
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
          {isTerminal && (
            <>
              <button
                className="kanban-modal__action"
                title="Search this terminal"
                aria-pressed={searchOpen}
                onClick={() => setSearchOpen((v) => !v)}
              >
                <IconSearch />
              </button>
              <button
                className="kanban-modal__action"
                title="Dictate into this terminal"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('nodeterm:dictate', { detail: { nodeId: session.id } }))
                }
              >
                <IconMic />
              </button>
              <button
                className="kanban-modal__action"
                title="Name with AI (from terminal output)"
                disabled={naming}
                onClick={nameWithAi}
              >
                {naming ? '…' : '✦'}
              </button>
            </>
          )}
          <button
            className="kanban-modal__action"
            title={panelOpen ? 'Hide comments & activity' : 'Show comments & activity'}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <IconChat />
          </button>
          <button className="kanban-modal__action" title="Open on canvas" onClick={onOpenCanvas}>
            ↗
          </button>
          <button className="kanban-modal__action" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="kanban-modal__body">
          {/* Body is a flex row: the card's own pane (2/3) + the board-log panel (1/3, all kinds). */}
          <div className="kanban-modal__main">
            {session.kind === 'sticky' ? (
              <textarea
                className="kanban-modal__sticky"
                value={session.text ?? ''}
                placeholder="Write a note…"
                onChange={(e) => onEditSticky(e.target.value)}
              />
            ) : (
              <div className="kanban-modal__pane" data-kind={session.kind}>
                {session.kind === 'terminal' ? (
                  // A live SECOND client on the node's session — keyed by node id so switching cards
                  // remounts a fresh viewer. Chat has no PTY; it opens on the canvas. The markdown
                  // view OVERLAYS the terminal (kept mounted — its viewer must not detach/re-seed).
                  <ModalTerminal
                    key={session.id}
                    nodeId={session.id}
                    spawn={session.spawn}
                    searchOpen={searchOpen}
                    onCloseSearch={() => setSearchOpen(false)}
                  />
                ) : (
                  <div className="kanban-modal__placeholder">Chat sessions open on the canvas.</div>
                )}
              </div>
            )}
          </div>
          {panelOpen && <BoardLogPanel card={session} />}
        </div>
      </div>
    </div>,
    document.body
  )
}
