import { useState } from 'react'
import type { KanbanCard as KanbanCardT } from '@shared/types'
import { renderMarkdown } from '../../lib/markdown'

interface KanbanCardProps {
  card: KanbanCardT
  onEdit: (patch: { title?: string; description?: string }) => void
  onDelete: () => void
  onDragStart: () => void
  onDragEnd: () => void
  /** A dragged card was dropped on this card — insert it before this one. */
  onDropBefore: () => void
}

export function KanbanCard({ card, onEdit, onDelete, onDragStart, onDragEnd, onDropBefore }: KanbanCardProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description ?? '')

  const startEdit = () => {
    setTitle(card.title)
    setDescription(card.description ?? '')
    setEditing(true)
  }
  const save = () => {
    const t = title.trim()
    if (t) onEdit({ title: t, description: description.trim() || undefined })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="kanban-card kanban-card--editing">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <textarea
          placeholder="Description (markdown)…"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          }}
        />
        <div className="kanban-card__actions">
          <button onClick={() => setEditing(false)}>Cancel</button>
          <button className="kanban-card__save" onClick={save}>Save</button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="kanban-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation() // don't let the column's end-drop swallow a drop aimed at this card
        onDropBefore()
      }}
      onDoubleClick={startEdit}
    >
      <div className="kanban-card__title">{card.title}</div>
      {card.description && (
        <div
          className="kanban-card__desc"
          // renderMarkdown sanitizes via DOMPurify (lib/markdown.ts)
          dangerouslySetInnerHTML={{ __html: renderMarkdown(card.description) }}
        />
      )}
      <button className="kanban-card__close" title="Delete card" onClick={onDelete}>
        ✕
      </button>
    </div>
  )
}
