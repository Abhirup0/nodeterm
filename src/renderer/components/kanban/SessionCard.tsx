import { useState } from 'react'
import type { KanbanCardMeta } from '@shared/types'
import type { AgentNodeStatus } from '../../state/agentStatus'
import { ContextMeter } from '../ContextMeter'
import type { KanbanSession } from './KanbanView'

interface SessionCardProps {
  session: KanbanSession
  status?: AgentNodeStatus
  meta?: KanbanCardMeta
  /** Single click opens the card modal directly (the expand/collapse step was dropped). */
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  /** A dragged card was dropped on this card — insert it before this one. */
  onDropBefore: () => void
}

export function SessionCard({ session, status, meta, onOpen, onDragStart, onDragEnd, onDropBefore }: SessionCardProps) {
  // Local drag state only styles THIS card (ghost look) — the drag payload lives in KanbanView.
  const [dragging, setDragging] = useState(false)
  const badge =
    session.kind !== 'sticky' && status?.state === 'working'
      ? 'running'
      : session.kind !== 'sticky' && (status?.state === 'waiting' || status?.state === 'blocked')
        ? 'needs'
        : null
  const stickyPreview = session.kind === 'sticky' ? (session.text ?? '').trim() : ''
  const assignees = meta?.assignees ?? []
  const due = meta?.dueAt
  const overdue = due !== undefined && due < Date.now()
  const hasDetail = !!status?.sessionId || !!status?.session || stickyPreview.includes('\n')
  return (
    <div
      className={`kanban-card kanban-card--session${dragging ? ' kanban-card--dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        onDragStart()
      }}
      onDragEnd={() => {
        setDragging(false)
        onDragEnd()
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation() // don't let the column's end-drop swallow a drop aimed at this card
        onDropBefore()
      }}
      onClick={onOpen}
      title="Open card"
    >
      <div className="kanban-card__row">
        <span className="kanban-card__nodedot" style={{ background: session.color }} />
        <span className="kanban-card__title">{session.title}</span>
        {session.kind === 'sticky' && <span className="kanban-card__kind">note</span>}
        {badge === 'running' && <span className="kanban-badge kanban-badge--running">RUNNING</span>}
        {badge === 'needs' && <span className="kanban-badge kanban-badge--needs">NEEDS YOU</span>}
        {status?.unread && <span className="kanban-card__unread" />}
      </div>
      {(assignees.length > 0 || due !== undefined) && (
        <div className="kanban-card__metarow">
          {due !== undefined && (
            <span className={`kanban-due${overdue ? ' kanban-due--overdue' : ''}`}>
              {new Date(due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </span>
          )}
          <span className="kanban-card__avatars">
            {assignees.slice(0, 3).map((a) => (
              <span key={a.name} className="kanban-avatar kanban-avatar--sm" style={{ background: a.color }} title={a.name}>
                {(a.name.trim()[0] ?? '?').toUpperCase()}
              </span>
            ))}
            {assignees.length > 3 && <span className="kanban-avatar kanban-avatar--sm kanban-avatar--more">+{assignees.length - 3}</span>}
          </span>
        </div>
      )}
      {/* Detail line is ALWAYS visible when the card has something to say (no expand step):
          agents show the context meter + session chip; multi-line notes show a preview. */}
      {hasDetail && (
        <div className="kanban-card__detail" onClick={(e) => e.stopPropagation()}>
          {session.kind === 'sticky' ? (
            <span className="kanban-card__stickytext">{stickyPreview}</span>
          ) : (
            <>
              <ContextMeter sessionId={status?.sessionId ?? null} />
              {status?.session && (
                <span className="kanban-card__session" title={status.session}>
                  {status.session}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
