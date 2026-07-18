import type { KanbanCard, ProjectKanban } from '@shared/types'
import { NODE_COLORS } from '../state/workspace'

// Pure kanban board transforms — the ONLY place board structure changes. The UI computes
// the next board here and hands it whole to setProjectKanban (no second live source).
// Every function returns a new board; unknown ids are no-ops returning the input.

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
    cards: []
  }
}

/** A column's cards in board order (order = relative position in the cards array). */
export function cardsInColumn(k: ProjectKanban, columnId: string): KanbanCard[] {
  return k.cards.filter((c) => c.columnId === columnId)
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

/** Deletes a column, migrating its cards to the first remaining column. Returns null
 *  when this is the last column — the board always keeps ≥ 1 column. */
export function deleteColumn(k: ProjectKanban, columnId: string): ProjectKanban | null {
  if (!k.columns.some((c) => c.id === columnId)) return k
  if (k.columns.length <= 1) return null
  const columns = k.columns.filter((c) => c.id !== columnId)
  const target = columns[0].id
  return {
    columns,
    cards: k.cards.map((c) => (c.columnId === columnId ? { ...c, columnId: target } : c))
  }
}

export function addCard(k: ProjectKanban, columnId: string, title: string, createdAt: number): ProjectKanban {
  if (!k.columns.some((c) => c.id === columnId)) return k
  return { ...k, cards: [...k.cards, { id: kid('kcard'), columnId, title, createdAt }] }
}

export function updateCard(
  k: ProjectKanban,
  cardId: string,
  patch: { title?: string; description?: string }
): ProjectKanban {
  return {
    ...k,
    cards: k.cards.map((c) => {
      if (c.id !== cardId) return c
      const next = { ...c, ...patch }
      if (!next.description) delete next.description // emptied body: drop the key, keep the file clean
      return next
    })
  }
}

export function deleteCard(k: ProjectKanban, cardId: string): ProjectKanban {
  return { ...k, cards: k.cards.filter((c) => c.id !== cardId) }
}

/** Moves a card into `toColumnId`, before `beforeCardId` (null — or a card that is not
 *  in the target column — = end of that column). */
export function moveCard(
  k: ProjectKanban,
  cardId: string,
  toColumnId: string,
  beforeCardId: string | null
): ProjectKanban {
  if (cardId === beforeCardId) return k
  const card = k.cards.find((c) => c.id === cardId)
  if (!card || !k.columns.some((c) => c.id === toColumnId)) return k
  const moved = { ...card, columnId: toColumnId }
  const without = k.cards.filter((c) => c.id !== cardId)
  const before = beforeCardId
    ? without.find((c) => c.id === beforeCardId && c.columnId === toColumnId)
    : undefined
  const idx = before ? without.indexOf(before) : -1
  const at = idx === -1 ? without.length : idx
  return { ...k, cards: [...without.slice(0, at), moved, ...without.slice(at)] }
}
