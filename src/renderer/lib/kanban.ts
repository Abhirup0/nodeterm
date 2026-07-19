import type { BoardLogAuthor, KanbanAssignment, KanbanCardMeta, KanbanColumn, KanbanPriority, ProjectKanban } from '@shared/types'
import { NODE_COLORS } from '../state/workspace'

// Pure kanban board transforms — the ONLY place board structure changes. The UI computes
// the next board here and hands it whole to setProjectKanban (no second live source).
// Every function returns a new board; unknown ids are no-ops returning the input.
// Cards are the project's SESSION NODES — the board stores only column assignments; a
// session with no (or dangling) assignment sits in the virtual Ungrouped column.

const kid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

/** Default board for a project whose file has no `kanban` yet. NOT written to disk
 *  until the first user edit (the spec's lazy-default rule). */
export function defaultKanban(): ProjectKanban {
  return {
    columns: [
      { id: kid('kcol'), title: 'To Do', color: NODE_COLORS[0] },
      { id: kid('kcol'), title: 'In Progress', color: NODE_COLORS[2] },
      { id: kid('kcol'), title: 'Done', color: NODE_COLORS[1] }
    ],
    assignments: []
  }
}

/** Color for the next added column — cycles the node palette. */
export function nextColumnColor(k: ProjectKanban): string {
  return NODE_COLORS[k.columns.length % NODE_COLORS.length]
}

export function addColumn(k: ProjectKanban, title: string, color: string): ProjectKanban {
  return { ...k, columns: [...k.columns, { id: kid('kcol'), title, color }] }
}

export function renameColumn(k: ProjectKanban, columnId: string, title: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, title } : c)) }
}

export function recolorColumn(k: ProjectKanban, columnId: string, color: string): ProjectKanban {
  return { ...k, columns: k.columns.map((c) => (c.id === columnId ? { ...c, color } : c)) }
}

/** Moves a column before `beforeId` (null = to the end). */
export function moveColumn(k: ProjectKanban, columnId: string, beforeId: string | null): ProjectKanban {
  if (columnId === beforeId) return k
  const dragged = k.columns.find((c) => c.id === columnId)
  if (!dragged) return k
  const without = k.columns.filter((c) => c.id !== columnId)
  const idx = beforeId ? without.findIndex((c) => c.id === beforeId) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, columns: [...without.slice(0, at), dragged, ...without.slice(at)] }
}

/** Deletes a user column; its assigned sessions return to Ungrouped (assignments drop).
 *  Non-destructive by design — sessions are untouched, so no confirm dialog and no
 *  last-column rule (the virtual Ungrouped column always remains). */
export function deleteColumn(k: ProjectKanban, columnId: string): ProjectKanban {
  if (!k.columns.some((c) => c.id === columnId)) return k
  return {
    columns: k.columns.filter((c) => c.id !== columnId),
    assignments: k.assignments.filter((a) => a.columnId !== columnId)
  }
}

/** Node ids assigned to `columnId`, in board order. */
export function assignedTo(k: ProjectKanban, columnId: string): string[] {
  return k.assignments.filter((a) => a.columnId === columnId).map((a) => a.nodeId)
}

/** Ids from `sessionIds` with no live assignment — never assigned, or assigned to a column
 *  that no longer exists (e.g. a git merge kept the assignment but lost the column). Order
 *  follows `sessionIds` (= canvas order). */
export function unassigned(k: ProjectKanban, sessionIds: string[]): string[] {
  const cols = new Set(k.columns.map((c) => c.id))
  const assigned = new Set(
    k.assignments.filter((a) => cols.has(a.columnId)).map((a) => a.nodeId)
  )
  return sessionIds.filter((id) => !assigned.has(id))
}

/** Assigns/moves a session card. `columnId` null = back to Ungrouped (assignment removed;
 *  Ungrouped order is canvas order, so `beforeNodeId` is ignored there). Inserts before
 *  `beforeNodeId`'s assignment when that assignment is in the target column, else at the
 *  end. Unknown target column is a no-op. */
export function assignNode(
  k: ProjectKanban,
  nodeId: string,
  columnId: string | null,
  beforeNodeId: string | null
): ProjectKanban {
  if (nodeId === beforeNodeId) return k
  if (columnId === null) {
    if (!k.assignments.some((a) => a.nodeId === nodeId)) return k
    return { ...k, assignments: k.assignments.filter((a) => a.nodeId !== nodeId) }
  }
  if (!k.columns.some((c) => c.id === columnId)) return k
  const moved: KanbanAssignment = { nodeId, columnId }
  const without = k.assignments.filter((a) => a.nodeId !== nodeId)
  const before = beforeNodeId
    ? without.find((a) => a.nodeId === beforeNodeId && a.columnId === columnId)
    : undefined
  const idx = before ? without.indexOf(before) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, assignments: [...without.slice(0, at), moved, ...without.slice(at)] }
}

/** Drops assignments of nodes that no longer exist. Returns the SAME object when nothing
 *  changed, so callers can cheaply skip a no-op persist. */
export function pruneAssignments(k: ProjectKanban, liveIds: string[]): ProjectKanban {
  const live = new Set(liveIds)
  const assignments = k.assignments.filter((a) => live.has(a.nodeId))
  const meta = metaList(k).filter((m) => m && live.has(m.nodeId))
  const sameAssignments = assignments.length === k.assignments.length
  const sameMeta = meta.length === metaList(k).length
  if (sameAssignments && sameMeta) return k
  const next: ProjectKanban = { ...k, assignments }
  if (Array.isArray(k.meta)) {
    if (meta.length) next.meta = meta
    else delete next.meta
  }
  return next
}

/** The column a node is assigned to, resolved against a project's board — undefined when
 *  unassigned, dangling (column deleted elsewhere), or the project has no board yet. All
 *  three mean Ungrouped, and the canvas shows no column pill for Ungrouped. */
export function columnForNode(
  k: ProjectKanban | undefined,
  nodeId: string
): KanbanColumn | undefined {
  if (!k) return undefined
  const a = k.assignments.find((x) => x.nodeId === nodeId)
  return a ? k.columns.find((c) => c.id === a.columnId) : undefined
}

/** Tolerant read of a card's metadata — `meta` may be absent or (hand-edited) malformed. */
export function cardMeta(k: ProjectKanban, nodeId: string): KanbanCardMeta | undefined {
  if (!Array.isArray(k.meta)) return undefined
  return k.meta.find((m) => m && m.nodeId === nodeId)
}

const metaList = (k: ProjectKanban): KanbanCardMeta[] => (Array.isArray(k.meta) ? k.meta : [])

/** Writes one card's meta back; an entry with no fields left is DROPPED (absent = clean file),
 *  and an emptied meta array drops the key entirely. */
function withCardMeta(
  k: ProjectKanban,
  nodeId: string,
  next: Omit<KanbanCardMeta, 'nodeId'> | null
): ProjectKanban {
  const rest = metaList(k).filter((m) => m && m.nodeId !== nodeId)
  const keep =
    next &&
    ((next.assignees?.length ?? 0) > 0 || next.dueAt !== undefined || next.priority !== undefined)
  const meta = keep ? [...rest, { nodeId, ...next }] : rest
  const { meta: _m, ...bare } = k
  return meta.length ? { ...bare, meta } : bare
}

/** Adds the person to the card (or removes them if already assigned — matched by NAME, the
 *  presence identity's stable part; color is display-only and may drift per machine). */
export function toggleAssignee(
  k: ProjectKanban,
  nodeId: string,
  person: BoardLogAuthor
): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  const had = (cur?.assignees ?? []).some((a) => a.name === person.name)
  const assignees = had
    ? (cur?.assignees ?? []).filter((a) => a.name !== person.name)
    : [...(cur?.assignees ?? []), person]
  return withCardMeta(k, nodeId, { assignees, dueAt: cur?.dueAt, priority: cur?.priority })
}

/** Sets (or clears, with null) the card's due timestamp. */
export function setCardDue(k: ProjectKanban, nodeId: string, dueAt: number | null): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  return withCardMeta(k, nodeId, {
    assignees: cur?.assignees,
    priority: cur?.priority,
    ...(dueAt === null ? {} : { dueAt })
  })
}

/** Sets (or clears, with null) the card's priority. */
export function setCardPriority(
  k: ProjectKanban,
  nodeId: string,
  priority: KanbanPriority | null
): ProjectKanban {
  const cur = cardMeta(k, nodeId)
  return withCardMeta(k, nodeId, {
    assignees: cur?.assignees,
    dueAt: cur?.dueAt,
    ...(priority === null ? {} : { priority })
  })
}
