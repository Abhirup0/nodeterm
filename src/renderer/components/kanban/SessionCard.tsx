import type { AgentNodeStatus } from '../../state/agentStatus'
import type { KanbanSession } from './KanbanView'

interface SessionCardProps {
  session: KanbanSession
  status?: AgentNodeStatus
  /** Open on canvas: switch back to canvas view and focus this node. */
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  /** A dragged card was dropped on this card — insert it before this one. */
  onDropBefore: () => void
}

export function SessionCard({ session, status, onOpen, onDragStart, onDragEnd, onDropBefore }: SessionCardProps) {
  const badge =
    status?.state === 'working'
      ? 'running'
      : status?.state === 'waiting' || status?.state === 'blocked'
        ? 'needs'
        : null
  return (
    <div
      className="kanban-card kanban-card--session"
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
      onClick={onOpen}
      title="Open on canvas"
    >
      <span className="kanban-card__nodedot" style={{ background: session.color }} />
      <span className="kanban-card__title">{session.title}</span>
      {session.kind === 'chat' && <span className="kanban-card__kind">chat</span>}
      {badge === 'running' && <span className="kanban-badge kanban-badge--running">RUNNING</span>}
      {badge === 'needs' && <span className="kanban-badge kanban-badge--needs">NEEDS YOU</span>}
      {status?.unread && <span className="kanban-card__unread" />}
    </div>
  )
}
