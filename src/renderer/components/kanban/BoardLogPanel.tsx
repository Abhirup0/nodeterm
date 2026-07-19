import { useEffect, useState } from 'react'
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'
import { formatTimeAgo } from '../../lib/usageFormat'
import { useSession } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useBoardLog } from '../../state/boardLog'
import type { KanbanSession } from './KanbanView'

interface BoardLogPanelProps {
  /** The card/node whose activity this panel shows — feed + composer are scoped to `card.id`.
   *  Only the id is needed, so the canvas node flyout can use this panel without building a
   *  full KanbanSession. */
  card: Pick<KanbanSession, 'id'>
}

/** Human one-liner for an activity event. column-* events carry no nodeId and so never reach a
 *  card-scoped feed; they are handled defensively for completeness. */
function eventLine(name: string, e: BoardLogEvent): string {
  switch (e.type) {
    case 'card-created':
      return `${name} created this card in ${e.to ?? 'Ungrouped'}`
    case 'card-moved':
      return `${name} moved this card ${e.from ?? 'Ungrouped'} → ${e.to ?? 'Ungrouped'}`
    case 'column-added':
      return `${name} added column ${e.title ?? ''}`.trimEnd()
    case 'column-renamed':
      return `${name} renamed column ${e.from ?? ''} → ${e.to ?? ''}`
    case 'column-deleted':
      return `${name} deleted column ${e.title ?? ''}`.trimEnd()
  }
}

/** Right panel of the card modal (all card kinds): a composer on top and the card's own
 *  comments + activity feed newest-first. Reads/writes the board log for the ACTIVE project via
 *  its session api — resolved here (not threaded from Canvas). Subscribes on mount, so a teammate's
 *  comment or a board change lands live; unsubscribes on unmount / card swap. */
export function BoardLogPanel({ card }: BoardLogPanelProps) {
  const { api } = useSession()
  const projectId = useProjects((s) => s.activeProjectId)
  const entries = useBoardLog((s) => s.entriesFor(projectId))
  const unsupported = useBoardLog((s) => !!s.unsupportedByProject[projectId])
  const error = useBoardLog((s) => !!s.errorByProject[projectId])
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!projectId) return
    void useBoardLog.getState().load(api, projectId)
    const unsub = useBoardLog.getState().subscribeChanged(api, projectId)
    return unsub
  }, [api, projectId])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    useBoardLog.getState().append(api, projectId, { kind: 'comment', nodeId: card.id, text })
    setDraft('')
  }

  // Card-scoped: this card's comments + its own events. Column events (no nodeId) never match.
  const feed = (entries ?? []).filter((e) => e.nodeId === card.id)

  return (
    <div className="board-log">
      <div className="board-log__title">Comments & activity</div>
      {unsupported ? (
        <div className="board-log__hint">Board history needs a project folder</div>
      ) : (
        <textarea
          className="board-log__composer"
          value={draft}
          placeholder="Write a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
            // Never submit mid-IME-composition (e.g. selecting a kanji candidate with Enter).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
      )}
      {!unsupported && error && (
        <div className="board-log__error">Some board history couldn’t be saved.</div>
      )}
      <div className="board-log__feed">
        {feed.map((entry) => (
          <FeedRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function FeedRow({ entry }: { entry: BoardLogEntry }) {
  const when = formatTimeAgo(entry.ts)
  if (entry.kind === 'event' && entry.event) {
    return <div className="board-log__event">{eventLine(entry.author.name, entry.event)}</div>
  }
  return (
    <div className="board-log__comment">
      <div className="board-log__meta">
        <span className="board-log__dot" style={{ background: entry.author.color }} />
        <span className="board-log__author">{entry.author.name}</span>
        <span className="board-log__time">{when}</span>
      </div>
      <div className="board-log__text">{entry.text}</div>
    </div>
  )
}
