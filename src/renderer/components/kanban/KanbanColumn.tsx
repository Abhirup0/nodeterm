import { useState } from 'react'
import type { KanbanCard as KanbanCardT, KanbanColumn as KanbanColumnT } from '@shared/types'
import { NODE_COLORS } from '../../state/workspace'
import { KanbanCard } from './KanbanCard'

interface KanbanColumnProps {
  column: KanbanColumnT
  cards: KanbanCardT[]
  onRename: (title: string) => void
  onRecolor: (color: string) => void
  onRequestDelete: () => void
  onAddCard: (title: string) => void
  onEditCard: (cardId: string, patch: { title?: string; description?: string }) => void
  onDeleteCard: (cardId: string) => void
  // Drag plumbing — the single drag source of truth lives in KanbanView.
  onCardDragStart: (cardId: string) => void
  onColumnDragStart: () => void
  onDragEnd: () => void
  /** Drop on the column body: a card lands at the END of this column; a column lands BEFORE it. */
  onDropOnColumn: () => void
  onDropBeforeCard: (cardId: string) => void
}

export function KanbanColumn({
  column, cards, onRename, onRecolor, onRequestDelete, onAddCard, onEditCard, onDeleteCard,
  onCardDragStart, onColumnDragStart, onDragEnd, onDropOnColumn, onDropBeforeCard
}: KanbanColumnProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(column.title)
  const [swatchesOpen, setSwatchesOpen] = useState(false)
  const [composer, setComposer] = useState('')

  const commitTitle = () => {
    const t = title.trim()
    if (t && t !== column.title) onRename(t)
    setEditingTitle(false)
  }
  const addCard = () => {
    const t = composer.trim()
    if (t) onAddCard(t)
    setComposer('')
  }

  return (
    <div
      className="kanban-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDropOnColumn()
      }}
    >
      <div
        className="kanban-col__header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onColumnDragStart()
        }}
        onDragEnd={onDragEnd}
      >
        <button
          className="kanban-col__dot"
          style={{ background: column.color }}
          title="Column color"
          onClick={() => setSwatchesOpen((v) => !v)}
        />
        {editingTitle ? (
          <input
            className="kanban-col__rename"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <span
            className="kanban-col__title"
            onClick={() => {
              setTitle(column.title)
              setEditingTitle(true)
            }}
          >
            {column.title}
          </span>
        )}
        <span className="kanban-col__count">{cards.length}</span>
        <button className="kanban-col__close" title="Delete column" onClick={onRequestDelete}>
          ✕
        </button>
      </div>
      {swatchesOpen && (
        <div className="kanban-col__swatches">
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className="kanban-col__swatch"
              style={{ background: c }}
              onClick={() => {
                onRecolor(c)
                setSwatchesOpen(false)
              }}
            />
          ))}
        </div>
      )}
      <div className="kanban-col__cards">
        {cards.map((card) => (
          <KanbanCard
            key={card.id}
            card={card}
            onEdit={(patch) => onEditCard(card.id, patch)}
            onDelete={() => onDeleteCard(card.id)}
            onDragStart={() => onCardDragStart(card.id)}
            onDragEnd={onDragEnd}
            onDropBefore={() => onDropBeforeCard(card.id)}
          />
        ))}
      </div>
      <div className="kanban-col__composer">
        <input
          placeholder="Add a card…"
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addCard()
          }}
        />
      </div>
    </div>
  )
}
