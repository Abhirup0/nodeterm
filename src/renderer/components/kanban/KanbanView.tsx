import { useRef, useState } from 'react'
import type { ProjectKanban } from '@shared/types'
import { ConfirmDialog } from '../ConfirmDialog'
import {
  addCard, addColumn, cardsInColumn, deleteCard, deleteColumn, moveCard, moveColumn,
  nextColumnColor, recolorColumn, renameColumn, updateCard
} from '../../lib/kanban'
import { KanbanColumn } from './KanbanColumn'

interface KanbanViewProps {
  board: ProjectKanban
  onChange: (next: ProjectKanban) => void
}

type Drag = { kind: 'card' | 'column'; id: string } | null

/** Full-page task board OVER the canvas. The canvas stays mounted underneath (its
 *  agent-status listeners must keep running, and display:none would 0×0-resize every
 *  terminal into a tmux SIGWINCH) — this is an opaque overlay, nothing more. */
export function KanbanView({ board, onChange }: KanbanViewProps) {
  const [confirmCol, setConfirmCol] = useState<string | null>(null)
  const dragRef = useRef<Drag>(null)

  const requestDeleteColumn = (columnId: string) => {
    if (cardsInColumn(board, columnId).length === 0) {
      const next = deleteColumn(board, columnId)
      if (next) onChange(next)
    } else setConfirmCol(columnId)
  }

  const takeDrag = (): Drag => {
    const d = dragRef.current
    dragRef.current = null
    return d
  }

  const dropOnColumn = (columnId: string) => {
    const drag = takeDrag()
    if (!drag) return
    if (drag.kind === 'card') onChange(moveCard(board, drag.id, columnId, null))
    else onChange(moveColumn(board, drag.id, columnId))
  }

  const dropBeforeCard = (columnId: string, cardId: string) => {
    const drag = takeDrag()
    if (!drag) return
    if (drag.kind === 'card') onChange(moveCard(board, drag.id, columnId, cardId))
    else onChange(moveColumn(board, drag.id, columnId))
  }

  return (
    <div className="kanban-overlay">
      <div className="kanban-board">
        {board.columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            cards={cardsInColumn(board, col.id)}
            onRename={(t) => onChange(renameColumn(board, col.id, t))}
            onRecolor={(c) => onChange(recolorColumn(board, col.id, c))}
            onRequestDelete={() => requestDeleteColumn(col.id)}
            onAddCard={(t) => onChange(addCard(board, col.id, t, Date.now()))}
            onEditCard={(id, patch) => onChange(updateCard(board, id, patch))}
            onDeleteCard={(id) => onChange(deleteCard(board, id))}
            onCardDragStart={(id) => (dragRef.current = { kind: 'card', id })}
            onColumnDragStart={() => (dragRef.current = { kind: 'column', id: col.id })}
            onDragEnd={() => (dragRef.current = null)}
            onDropOnColumn={() => dropOnColumn(col.id)}
            onDropBeforeCard={(cardId) => dropBeforeCard(col.id, cardId)}
          />
        ))}
        <button
          className="kanban-add-col"
          onClick={() => onChange(addColumn(board, 'New column', nextColumnColor(board)))}
        >
          + Add column
        </button>
      </div>
      {confirmCol && (
        <ConfirmDialog
          message={`Delete this column? Its ${cardsInColumn(board, confirmCol).length} card(s) will move to the first column.`}
          confirmLabel="Delete column"
          onConfirm={() => {
            const next = deleteColumn(board, confirmCol)
            if (next) onChange(next)
            setConfirmCol(null)
          }}
          onCancel={() => setConfirmCol(null)}
        />
      )}
    </div>
  )
}
