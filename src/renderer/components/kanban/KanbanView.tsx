import { useRef, useState } from 'react'
import type { ProjectKanban } from '@shared/types'
import { useAgentStatus } from '../../state/agentStatus'
import { useProjects } from '../../state/projects'
import {
  addColumn, assignNode, assignedTo, deleteColumn, moveColumn, nextColumnColor,
  pruneAssignments, recolorColumn, renameColumn, unassigned
} from '../../lib/kanban'
import { KanbanColumn } from './KanbanColumn'

/** One session node shown as a board card — derived LIVE from the canvas nodes; the board
 *  itself stores only column assignments. */
export interface KanbanSession {
  id: string
  title: string
  color: string
  kind: 'terminal' | 'chat'
  agentId?: string
}

interface KanbanViewProps {
  board: ProjectKanban
  sessions: KanbanSession[]
  onChange: (next: ProjectKanban) => void
  /** Open a session from its card: switch back to canvas view and focus the node. */
  onOpenNode: (nodeId: string) => void
}

type Drag = { kind: 'card' | 'column'; id: string } | null

/** Full-page session board OVER the canvas. The canvas stays mounted underneath (its
 *  agent-status listeners must keep running, and display:none would 0×0-resize every
 *  terminal into a tmux SIGWINCH) — this is an opaque overlay, nothing more. */
export function KanbanView({ board, sessions, onChange, onOpenNode }: KanbanViewProps) {
  const dragRef = useRef<Drag>(null)
  const statusById = useAgentStatus((s) => s.byId)
  // Primitive selectors (not one object) — an object selector would re-render on every store set.
  const projectName = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name)
  const projectColor = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.color)
  // Card detail rows open per session id; transient by design (resets when the board closes).
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const byId = new Map(sessions.map((s) => [s.id, s]))

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Prune dead nodes' assignments on every persisted change, so they never accumulate
  // in the shared file.
  const commit = (next: ProjectKanban) =>
    onChange(pruneAssignments(next, sessions.map((s) => s.id)))

  const takeDrag = (): Drag => {
    const d = dragRef.current
    dragRef.current = null
    return d
  }

  // columnId null = the virtual Ungrouped column.
  const dropOnColumn = (columnId: string | null) => {
    const drag = takeDrag()
    if (!drag) return
    if (drag.kind === 'card') commit(assignNode(board, drag.id, columnId, null))
    else if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
    // a column dropped on Ungrouped is a no-op — Ungrouped is always first
  }

  const dropBeforeCard = (columnId: string | null, nodeId: string) => {
    const drag = takeDrag()
    if (!drag) return
    if (drag.kind === 'card') commit(assignNode(board, drag.id, columnId, nodeId))
    else if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
  }

  const sessionsFor = (ids: string[]) =>
    ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))

  return (
    <div className="kanban-overlay">
      {/* Title strip: names the board's project AND pushes the columns below the top-right
          controls cluster, so column headers never sit under its icons. */}
      <div className="kanban-header">
        <span className="kanban-header__dot" style={{ background: projectColor }} />
        <span className="kanban-header__name">{projectName}</span>
      </div>
      <div className="kanban-board">
        <KanbanColumn
          column={null}
          cards={sessionsFor(unassigned(board, sessions.map((s) => s.id)))}
          statusById={statusById}
          expandedIds={expandedIds}
          onToggleCard={toggleExpanded}
          onOpenNode={onOpenNode}
          onCardDragStart={(id) => (dragRef.current = { kind: 'card', id })}
          onDragEnd={() => (dragRef.current = null)}
          onDropOnColumn={() => dropOnColumn(null)}
          onDropBeforeCard={(id) => dropBeforeCard(null, id)}
        />
        {board.columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            cards={sessionsFor(assignedTo(board, col.id))}
            statusById={statusById}
            expandedIds={expandedIds}
            onToggleCard={toggleExpanded}
            onRename={(t) => commit(renameColumn(board, col.id, t))}
            onRecolor={(c) => commit(recolorColumn(board, col.id, c))}
            onDelete={() => commit(deleteColumn(board, col.id))}
            onOpenNode={onOpenNode}
            onCardDragStart={(id) => (dragRef.current = { kind: 'card', id })}
            onColumnDragStart={() => (dragRef.current = { kind: 'column', id: col.id })}
            onDragEnd={() => (dragRef.current = null)}
            onDropOnColumn={() => dropOnColumn(col.id)}
            onDropBeforeCard={(id) => dropBeforeCard(col.id, id)}
          />
        ))}
        <button
          className="kanban-add-col"
          onClick={() => commit(addColumn(board, 'New column', nextColumnColor(board)))}
        >
          + Add column
        </button>
      </div>
    </div>
  )
}
