import type { AgentNodeStatus } from '../../state/agentStatus'
import { ContextMeter } from '../ContextMeter'
import type { KanbanSession } from './KanbanView'

interface SessionCardProps {
  session: KanbanSession
  status?: AgentNodeStatus
  expanded: boolean
  /** Single click toggles the detail row — opening the node moved to ↗ / double-click. */
  onToggle: () => void
  /** Open on canvas: switch back to canvas view and focus this node. */
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  /** A dragged card was dropped on this card — insert it before this one. */
  onDropBefore: () => void
}

export function SessionCard({
  session, status, expanded, onToggle, onOpen, onDragStart, onDragEnd, onDropBefore
}: SessionCardProps) {
  const sticky = session.kind === 'sticky'
  const badge =
    !sticky && status?.state === 'working'
      ? 'running'
      : !sticky && (status?.state === 'waiting' || status?.state === 'blocked')
        ? 'needs'
        : null
  return (
    <div
      className={`kanban-card kanban-card--session${expanded ? ' kanban-card--expanded' : ''}`}
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
      onClick={onToggle}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      title={expanded ? 'Collapse' : 'Expand'}
    >
      <div className="kanban-card__row">
        <span className="kanban-card__nodedot" style={{ background: session.color }} />
        <span className="kanban-card__title">{session.title}</span>
        {session.kind === 'chat' && <span className="kanban-card__kind">chat</span>}
        {sticky && <span className="kanban-card__kind">note</span>}
        {badge === 'running' && <span className="kanban-badge kanban-badge--running">RUNNING</span>}
        {badge === 'needs' && <span className="kanban-badge kanban-badge--needs">NEEDS YOU</span>}
        {status?.unread && <span className="kanban-card__unread" />}
      </div>
      {expanded && (
        /* Clicks inside the detail row (meter popover, session chip) must not collapse the card. */
        <div className="kanban-card__detail" onClick={(e) => e.stopPropagation()}>
          {sticky ? (
            <span className="kanban-card__stickytext">{session.text || 'Empty note'}</span>
          ) : (
            <>
              <ContextMeter sessionId={status?.sessionId ?? null} />
              {status?.session && (
                <span className="kanban-card__session" title={status.session}>
                  {status.session}
                </span>
              )}
              {!status?.sessionId && (
                <span className="kanban-card__kindlabel">
                  {session.kind === 'chat' ? 'chat' : 'terminal'}
                </span>
              )}
            </>
          )}
          <button className="kanban-card__open" title="Open on canvas" onClick={onOpen}>
            ↗
          </button>
        </div>
      )}
    </div>
  )
}
