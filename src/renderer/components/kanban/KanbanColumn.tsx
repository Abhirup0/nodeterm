import { useState } from 'react'
import type { KanbanColumn as KanbanColumnT } from '@shared/types'
import type { AgentNodeStatus } from '../../state/agentStatus'
import { NODE_COLORS } from '../../state/workspace'
import { SessionCard } from './SessionCard'
import type { KanbanCreateChoice, KanbanCreateOption, KanbanSession } from './KanbanView'

interface KanbanColumnProps {
  /** null = the virtual Ungrouped column: fixed label, no rename/recolor/delete, header not draggable. */
  column: KanbanColumnT | null
  cards: KanbanSession[]
  statusById: Record<string, AgentNodeStatus>
  onRename?: (title: string) => void
  onRecolor?: (color: string) => void
  onDelete?: () => void
  /** Open a card's modal (↗ / double-click on the card). */
  onOpenCard: (nodeId: string) => void
  /** "+ New" menu entries (agents, terminal, sticky) and what to do when one is picked. */
  createOptions: KanbanCreateOption[]
  onCreate: (choice: KanbanCreateChoice) => void
  // Drag plumbing — the single drag source of truth lives in KanbanView.
  onCardDragStart: (nodeId: string) => void
  onColumnDragStart?: () => void
  onDragEnd: () => void
  /** Drop on the column body: a card lands at the END of this column; a column lands BEFORE it. */
  onDropOnColumn: () => void
  onDropBeforeCard: (nodeId: string) => void
}

export function KanbanColumn({
  column, cards, statusById, onRename, onRecolor, onDelete, onOpenCard,
  createOptions, onCreate, onCardDragStart, onColumnDragStart, onDragEnd, onDropOnColumn,
  onDropBeforeCard
}: KanbanColumnProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(column?.title ?? '')
  const [swatchesOpen, setSwatchesOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  // Trello-style drop highlight: counted enter/leave (dragleave fires when crossing children).
  const [dragOverCount, setDragOverCount] = useState(0)

  const commitTitle = () => {
    const t = title.trim()
    if (column && t && t !== column.title) onRename?.(t)
    setEditingTitle(false)
  }

  return (
    <div
      className={`kanban-col${column ? '' : ' kanban-col--ungrouped'}${dragOverCount > 0 ? ' kanban-col--drop' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => setDragOverCount((c) => c + 1)}
      onDragLeave={() => setDragOverCount((c) => Math.max(0, c - 1))}
      onDrop={(e) => {
        e.preventDefault()
        setDragOverCount(0)
        onDropOnColumn()
      }}
    >
      <div
        className="kanban-col__header"
        draggable={!!column}
        onDragStart={(e) => {
          if (!column) return
          e.dataTransfer.effectAllowed = 'move'
          onColumnDragStart?.()
        }}
        onDragEnd={onDragEnd}
      >
        {column ? (
          <button
            className="kanban-col__dot"
            style={{ background: column.color }}
            title="Column color"
            onClick={() => setSwatchesOpen((v) => !v)}
          />
        ) : (
          <span className="kanban-col__dot kanban-col__dot--ungrouped" />
        )}
        {column && editingTitle ? (
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
              if (!column) return
              setTitle(column.title)
              setEditingTitle(true)
            }}
          >
            {column ? column.title : 'Ungrouped'}
          </span>
        )}
        <span className="kanban-col__count">{cards.length}</span>
        {column && (
          <button className="kanban-col__close" title="Delete column (cards return to Ungrouped)" onClick={onDelete}>
            ✕
          </button>
        )}
      </div>
      {column && swatchesOpen && (
        <div className="kanban-col__swatches">
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className="kanban-col__swatch"
              style={{ background: c }}
              onClick={() => {
                onRecolor?.(c)
                setSwatchesOpen(false)
              }}
            />
          ))}
        </div>
      )}
      <div className="kanban-col__cards">
        {cards.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            status={statusById[s.id]}
            onOpen={() => onOpenCard(s.id)}
            onDragStart={() => onCardDragStart(s.id)}
            onDragEnd={onDragEnd}
            onDropBefore={() => onDropBeforeCard(s.id)}
          />
        ))}
      </div>
      <div className="kanban-col__footer">
        {newMenuOpen && (
          <div className="kanban-col__newmenu">
            {createOptions.map((o) => (
              <button
                key={o.key}
                onClick={() => {
                  setNewMenuOpen(false)
                  onCreate(o.choice)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <button className="kanban-col__new" onClick={() => setNewMenuOpen((v) => !v)}>
          + New session
        </button>
      </div>
    </div>
  )
}
