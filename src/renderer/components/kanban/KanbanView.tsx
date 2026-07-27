import { useEffect, useRef, useState } from 'react'
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
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { IconAgent, IconExternal, IconNote, IconSwitch, IconTerminal, IconTrash, IconWeb } from '../icons'

/** One session node shown as a board card — derived LIVE from the canvas nodes; the board
 *  itself stores only column assignments. */
export interface KanbanSession {
  id: string
  title: string
  color: string
  kind: 'terminal' | 'sticky' | 'browser'
  agentId?: string
  /** Sticky note body — shown in the expanded detail row. */
  text?: string
  /** Browser node URL (kind 'browser' only) — shown on the card, opened in the modal webview. */
  url?: string
  /** The subset of the node's `data` the card modal's co-attach terminal needs to spawn/join the
   *  same session (kind 'terminal' only; sticky passes `{}`). */
  spawn: ModalSpawn
}

/** What the per-column "+ New" menu can create. */
export type KanbanCreateChoice =
  | { kind: 'terminal' }
  | { kind: 'sticky' }
  | { kind: 'browser' }
  | { kind: 'agent'; agentId: AgentId }

/** One "+ New" menu entry (label + the choice it fires). */
export interface KanbanCreateOption {
  key: string
  label: string
  choice: KanbanCreateChoice
  icon: JSX.Element
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
  /** Permanently delete a node (ends its session) — routed through the canvas confirm. */
  onDeleteNode: (nodeId: string) => void
  /** Reports which node's card modal is open (null = none) so the canvas can target it — e.g.
   *  the dictation shortcut dictates into the open card's session, not a canvas selection. */
  onModalNodeChange: (nodeId: string | null) => void
  /** Persist a browser card's navigation (url/title) from the modal webview to the node. */
  onBrowserNav: (nodeId: string, patch: { url?: string; title?: string }) => void
}

type Drag = { kind: 'card' | 'column'; id: string } | null

/** Full-page session board OVER the canvas. The canvas stays mounted underneath (its
 *  agent-status listeners must keep running, and display:none would 0×0-resize every
 *  terminal into a tmux SIGWINCH) — this is an opaque overlay, nothing more. */
export function KanbanView({
  board, sessions, onChange, onOpenNode, onCreateNode, onRenameNode, onEditSticky, onDeleteNode,
  onModalNodeChange, onBrowserNav
}: KanbanViewProps) {
  const dragRef = useRef<Drag>(null)
  // One card modal at a time; a deleted node closes it via the byId.has render guard.
  const [modalNodeId, setModalNodeId] = useState<string | null>(null)
  // Right-click card menu (open on canvas / move / delete).
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  // Opening a card = you're looking at that session: clear its unread badge, and report the open
  // node to the canvas (dictation shortcut targeting).
  useEffect(() => {
    onModalNodeChange(modalNodeId)
    if (modalNodeId) useAgentStatus.getState().clearUnread(modalNodeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalNodeId])
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
      choice: { kind: 'agent', agentId: id } as KanbanCreateChoice,
      icon: <IconAgent />
    })),
    ...customAgents.map((a) => ({
      key: a.id,
      label: a.label,
      choice: { kind: 'agent', agentId: a.id } as KanbanCreateChoice,
      icon: <IconAgent />
    })),
    { key: 'terminal', label: 'Terminal', choice: { kind: 'terminal' }, icon: <IconTerminal /> },
    { key: 'browser', label: 'Browser', choice: { kind: 'browser' }, icon: <IconWeb /> },
    { key: 'sticky', label: 'Sticky note', choice: { kind: 'sticky' }, icon: <IconNote /> }
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

  const dropAtCard = (columnId: string | null, targetNodeId: string, side: 'before' | 'after') => {
    const drag = takeDrag()
    if (!drag) return
    if (drag.kind === 'column') {
      if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
      return
    }
    // "after this card" = "before the NEXT card in the column" (null = end of column).
    const ids = columnId === null ? unassigned(board, sessions.map((s) => s.id)) : assignedTo(board, columnId)
    let beforeId: string | null = targetNodeId
    if (side === 'after') {
      const i = ids.indexOf(targetNodeId)
      beforeId = i >= 0 && i + 1 < ids.length ? ids[i + 1] : null
    }
    commit(assignNode(board, drag.id, columnId, beforeId))
  }

  const sessionsFor = (ids: string[]) =>
    ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))

  // Right-click menu for a card: open on canvas, move to another column, delete.
  const cardMenuItems = (nodeId: string): MenuItem[] => {
    const curColId = columnForNode(board, nodeId)?.id ?? null
    const moveTargets: MenuItem[] = [
      ...(curColId !== null
        ? [{ label: 'Ungrouped', onClick: () => commit(assignNode(board, nodeId, null, null)) }]
        : []),
      ...board.columns
        .filter((c) => c.id !== curColId)
        .map((c) => ({
          label: c.title,
          onClick: () => commit(assignNode(board, nodeId, c.id, null))
        }))
    ]
    return [
      { label: 'Open card', icon: <IconExternal />, onClick: () => setModalNodeId(nodeId) },
      { label: 'Open on canvas', icon: <IconExternal />, onClick: () => onOpenNode(nodeId) },
      ...(moveTargets.length
        ? ([{ type: 'submenu', label: 'Move to', icon: <IconSwitch />, children: moveTargets }] as MenuItem[])
        : []),
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => onDeleteNode(nodeId) }
    ]
  }

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
          onDropAtCard={(id, side) => dropAtCard(null, id, side)}
          onCardContext={(id, x, y) => setCardMenu({ nodeId: id, x, y })}
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
            onDropAtCard={(id, side) => dropAtCard(col.id, id, side)}
            onCardContext={(id, x, y) => setCardMenu({ nodeId: id, x, y })}
          />
        ))}
        <button
          className="kanban-add-col"
          onClick={() => commit(addColumn(board, 'New column', nextColumnColor(board)))}
        >
          + Add column
        </button>
      </div>
      {cardMenu && byId.has(cardMenu.nodeId) && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          zIndex={60}
          items={cardMenuItems(cardMenu.nodeId)}
          onClose={() => setCardMenu(null)}
        />
      )}
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
          onBrowserNav={(patch) => onBrowserNav(modalNodeId, patch)}
        />
      )}
    </div>
  )
}
