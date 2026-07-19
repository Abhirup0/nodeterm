import { useRef, useState } from 'react'
import type { ProjectKanban } from '@shared/types'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'
import { useAgentStatus } from '../../state/agentStatus'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import {
  addColumn, assignNode, assignedTo, cardMeta, columnForNode, deleteColumn, moveColumn,
  nextColumnColor, pruneAssignments, recolorColumn, renameColumn, unassigned
} from '../../lib/kanban'
import { CardModal } from './CardModal'
import { KanbanColumn } from './KanbanColumn'
import type { ModalSpawn } from './ModalTerminal'

/** One session node shown as a board card — derived LIVE from the canvas nodes; the board
 *  itself stores only column assignments. */
export interface KanbanSession {
  id: string
  title: string
  color: string
  kind: 'terminal' | 'sticky'
  agentId?: string
  /** Sticky note body — shown in the expanded detail row. */
  text?: string
  /** The subset of the node's `data` the card modal's co-attach terminal needs to spawn/join the
   *  same session (kind 'terminal' only; sticky passes `{}`). */
  spawn: ModalSpawn
}

/** What the per-column "+ New" menu can create. */
export type KanbanCreateChoice =
  | { kind: 'terminal' }
  | { kind: 'sticky' }
  | { kind: 'agent'; agentId: AgentId }

/** One "+ New" menu entry (label + the choice it fires). */
export interface KanbanCreateOption {
  key: string
  label: string
  choice: KanbanCreateChoice
}

interface KanbanViewProps {
  board: ProjectKanban
  sessions: KanbanSession[]
  onChange: (next: ProjectKanban) => void
  /** Open a session from its card: switch back to canvas view and focus the node. */
  onOpenNode: (nodeId: string) => void
  /** Create a node from a column's "+ New" menu (columnId null = Ungrouped: no assignment). */
  onCreateNode: (choice: KanbanCreateChoice, columnId: string | null) => void
  /** Rename a node (same funnel as the sessions sidebar). */
  onRenameNode: (nodeId: string, title: string) => void
  /** Write-through a sticky node's body text (only fired for kind 'sticky'). */
  onEditSticky: (nodeId: string, text: string) => void
}

type Drag = { kind: 'card' | 'column'; id: string } | null

/** Full-page session board OVER the canvas. The canvas stays mounted underneath (its
 *  agent-status listeners must keep running, and display:none would 0×0-resize every
 *  terminal into a tmux SIGWINCH) — this is an opaque overlay, nothing more. */
export function KanbanView({
  board, sessions, onChange, onOpenNode, onCreateNode, onRenameNode, onEditSticky
}: KanbanViewProps) {
  const dragRef = useRef<Drag>(null)
  // One card modal at a time; a deleted node closes it via the byId.has render guard.
  const [modalNodeId, setModalNodeId] = useState<string | null>(null)
  const statusById = useAgentStatus((s) => s.byId)
  // Primitive selectors (not one object) — an object selector would re-render on every store set.
  const projectName = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name)
  const projectColor = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.color)
  const customAgents = useSettings((s) => s.settings.customAgents)
  // "+ New" menu entries: the builtin agents, the user's custom agents, then terminal + sticky
  // (same universe as the dock's add menu, minus canvas-only kinds).
  const createOptions: KanbanCreateOption[] = [
    ...BUILTIN_AGENT_IDS.map((id) => ({
      key: id,
      label: AGENT_CONFIG[id].label,
      choice: { kind: 'agent', agentId: id } as KanbanCreateChoice
    })),
    ...customAgents.map((a) => ({
      key: a.id,
      label: a.label,
      choice: { kind: 'agent', agentId: a.id } as KanbanCreateChoice
    })),
    { key: 'terminal', label: 'Terminal', choice: { kind: 'terminal' } },
    { key: 'sticky', label: 'Sticky note', choice: { kind: 'sticky' } }
  ]
  const byId = new Map(sessions.map((s) => [s.id, s]))

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
          metaOf={(id) => cardMeta(board, id)}
          onOpenCard={setModalNodeId}
          createOptions={createOptions}
          onCreate={(choice) => onCreateNode(choice, null)}
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
            metaOf={(id) => cardMeta(board, id)}
            onRename={(t) => commit(renameColumn(board, col.id, t))}
            onRecolor={(c) => commit(recolorColumn(board, col.id, c))}
            onDelete={() => commit(deleteColumn(board, col.id))}
            onOpenCard={setModalNodeId}
            createOptions={createOptions}
            onCreate={(choice) => onCreateNode(choice, col.id)}
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
      {modalNodeId && byId.has(modalNodeId) && (
        <CardModal
          session={byId.get(modalNodeId)!}
          columnTitle={columnForNode(board, modalNodeId)?.title ?? null}
          board={board}
          onChangeBoard={commit}
          onClose={() => setModalNodeId(null)}
          onOpenCanvas={() => {
            setModalNodeId(null)
            onOpenNode(modalNodeId)
          }}
          onRename={(t) => onRenameNode(modalNodeId, t)}
          onEditSticky={(t) => onEditSticky(modalNodeId, t)}
        />
      )}
    </div>
  )
}
