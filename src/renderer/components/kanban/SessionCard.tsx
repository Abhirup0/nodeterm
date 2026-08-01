import { useState } from 'react'
import type { KanbanCardMeta, KanbanLabel, KanbanPriority } from '@shared/types'
import type { AgentNodeStatus } from '../../state/agentStatus'
import { ContextMeter } from '../ContextMeter'
import { LabelChips } from './LabelChips'
import type { KanbanSession } from './KanbanView'

interface SessionCardProps {
  session: KanbanSession
  status?: AgentNodeStatus
  meta?: KanbanCardMeta
  /** Resolved board labels on this card (LabelChips) — resolved by the board, passed in. */
  labels?: KanbanLabel[]
  /** Single click opens the card modal directly (the expand/collapse step was dropped). */
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  /** A dragged card was dropped on this card — before it (top half) or after it (bottom half). */
  onDropAt: (side: 'before' | 'after') => void
  /** Right-click on the card — opens the actions menu at the cursor. */
  onContext: (x: number, y: number) => void
}

export function SessionCard({ session, status, meta, labels = [], onOpen, onDragStart, onDragEnd, onDropAt, onContext }: SessionCardProps) {
  // Local drag state only styles THIS card (ghost look) — the drag payload lives in KanbanView.
  const [dragging, setDragging] = useState(false)
  // Which edge a drag is hovering over → shows the drop line (top = before, bottom = after).
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null)
  const sideFor = (e: React.DragEvent): 'before' | 'after' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  }
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
  const priority = meta?.priority
  const PRIO_COLOR: Record<KanbanPriority, string> = {
    low: '#8e8e93',
    medium: '#ffd60a',
    high: '#ff9f0a',
    urgent: '#ff453a'
  }
  const hasDetail = !!status?.sessionId || !!status?.session || stickyPreview.includes('\n')
  return (
    <div
      className={`kanban-card kanban-card--session${dragging ? ' kanban-card--dragging' : ''}${
        dropSide ? ` kanban-card--drop-${dropSide}` : ''
      }`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        onDragStart()
      }}
      onDragEnd={() => {
        setDragging(false)
        setDropSide(null)
        onDragEnd()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        const side = sideFor(e)
        if (side !== dropSide) setDropSide(side)
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation() // don't let the column's end-drop swallow a drop aimed at this card
        const side = sideFor(e)
        setDropSide(null)
        onDropAt(side)
      }}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        onContext(e.clientX, e.clientY)
      }}
      title="Open card"
    >
      <div className="kanban-card__row">
        <span className="kanban-card__nodedot" style={{ background: session.color }} />
        <span className="kanban-card__title">{session.title}</span>
        {session.kind === 'sticky' && <span className="kanban-card__kind">note</span>}
        {session.kind === 'browser' && <span className="kanban-card__kind">web</span>}
        {badge === 'running' && <span className="kanban-badge kanban-badge--running">RUNNING</span>}
        {badge === 'needs' && <span className="kanban-badge kanban-badge--needs">NEEDS YOU</span>}
        {status?.unread && <span className="kanban-card__unread" />}
      </div>
      <LabelChips labels={labels} size="sm" className="kanban-card__labels" />
      {(assignees.length > 0 || due !== undefined || priority !== undefined) && (
        <div className="kanban-card__metarow">
          {priority !== undefined && PRIO_COLOR[priority] && (
            <span
              className="kanban-due kanban-prio-chip"
              style={{ background: `${PRIO_COLOR[priority]}26`, color: PRIO_COLOR[priority] }}
            >
              {priority.toUpperCase()}
            </span>
          )}
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
