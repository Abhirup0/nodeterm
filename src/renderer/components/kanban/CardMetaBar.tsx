import { useMemo, useState } from 'react'
import type { BoardLogAuthor, ProjectKanban } from '@shared/types'
import { cardMeta, setCardDue, toggleAssignee } from '../../lib/kanban'
import { loadIdentity, selectOthers, usePresence } from '../../state/presence'
import { useBoardLog } from '../../state/boardLog'
import { useProjects } from '../../state/projects'

const initialOf = (name: string): string => (name.trim()[0] ?? '?').toUpperCase()

/** Local-wallclock value for a datetime-local input (its value is timezone-less). */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

interface CardMetaBarProps {
  nodeId: string
  board: ProjectKanban
  onChange: (next: ProjectKanban) => void
}

/** Trello-style Members / Due date strip under the modal header. The assignable pool is
 *  everyone the session can NAME: me (presence identity), live presence peers, and every
 *  author already seen in the board log — no separate membership system. */
export function CardMetaBar({ nodeId, board, onChange }: CardMetaBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const meta = cardMeta(board, nodeId)
  const projectId = useProjects((s) => s.activeProjectId)
  const logEntries = useBoardLog((s) => s.entriesFor(projectId))
  const peers = usePresence(selectOthers)

  const pool = useMemo(() => {
    const seen = new Map<string, BoardLogAuthor>()
    const add = (a: { name?: string; color?: string } | null | undefined): void => {
      if (a?.name && a.color && !seen.has(a.name)) seen.set(a.name, { name: a.name, color: a.color })
    }
    add(loadIdentity() ?? { name: 'you', color: '#8e8e93' })
    for (const p of peers) add(p)
    for (const e of logEntries) add(e.author)
    return [...seen.values()]
  }, [peers, logEntries])

  const assignees = meta?.assignees ?? []
  const due = meta?.dueAt
  const overdue = due !== undefined && due < Date.now()

  return (
    <div className="kanban-meta">
      <div className="kanban-meta__group">
        <span className="kanban-meta__label">Members</span>
        <div className="kanban-meta__row">
          {assignees.map((a) => (
            <button
              key={a.name}
              className="kanban-avatar"
              style={{ background: a.color }}
              title={`${a.name} — click to unassign`}
              onClick={() => onChange(toggleAssignee(board, nodeId, a))}
            >
              {initialOf(a.name)}
            </button>
          ))}
          <button
            className="kanban-avatar kanban-avatar--add"
            title="Assign a member"
            onClick={() => setPickerOpen((v) => !v)}
          >
            +
          </button>
          {pickerOpen && (
            <div className="kanban-meta__picker">
              {pool.map((p) => {
                const on = assignees.some((a) => a.name === p.name)
                return (
                  <button key={p.name} onClick={() => onChange(toggleAssignee(board, nodeId, p))}>
                    <span className="kanban-avatar" style={{ background: p.color }}>
                      {initialOf(p.name)}
                    </span>
                    <span className="kanban-meta__pname">{p.name}</span>
                    {on && <span className="kanban-meta__check">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div className="kanban-meta__group">
        <span className="kanban-meta__label">Due date</span>
        <div className="kanban-meta__row">
          <input
            type="datetime-local"
            className="kanban-meta__due"
            value={due !== undefined ? toLocalInput(due) : ''}
            onChange={(e) =>
              onChange(
                setCardDue(board, nodeId, e.target.value ? new Date(e.target.value).getTime() : null)
              )
            }
          />
          {overdue && <span className="kanban-due kanban-due--overdue">Overdue</span>}
          {due !== undefined && (
            <button
              className="kanban-meta__clear"
              title="Clear due date"
              onClick={() => onChange(setCardDue(board, nodeId, null))}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
