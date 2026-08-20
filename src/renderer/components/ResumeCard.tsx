import { useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import { relativeTime } from '../lib/relativeTime'

/** How many stops the card offers. Small on purpose: this is "where was I?", not the whole trail. */
const RESUME_CARD_COUNT = 3

interface ResumeCardProps {
  project: Project
  /** The project's LIVE canvas nodes — a breadcrumb whose node is gone is never offered. */
  nodes: readonly { id: string }[]
  onOpen: (nodeId: string) => void
}

/**
 * Canvas-mounted "resume where you left off" card: the last few deliberate node landings for the
 * ACTIVE project (breadcrumbs are per-project — see `NavStop`), each a click away.
 *
 * WHO decides it is shown: the caller. Canvas mounts this once per project activation per app run
 * and unmounts it afterwards, so the once-only rule lives there, not here. The one piece of state
 * this component owns is its OWN dismissal — a breadcrumb recorded while the card is up re-renders
 * the parent with a new `project` object, and without a local flag that would resurrect a card the
 * user just closed in the same activation.
 *
 * The rows are filtered BEFORE they are capped: slicing the raw tail first would show fewer than
 * `RESUME_CARD_COUNT` rows whenever the newest stops point at nodes that have since been deleted.
 */
export function ResumeCard({ project, nodes, onOpen }: ResumeCardProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  const liveIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const rows = useMemo(
    () =>
      (project.breadcrumbs ?? [])
        .filter((stop) => liveIds.has(stop.nodeId))
        .slice(-RESUME_CARD_COUNT)
        .reverse(),
    [project.breadcrumbs, liveIds]
  )

  if (dismissed || rows.length === 0) return null

  return (
    <div className="resume-card">
      <div className="resume-card__header">
        <span className="resume-card__title">Resume where you left off</span>
        <button
          className="resume-card__close"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          ✕
        </button>
      </div>
      <div className="resume-card__rows">
        {rows.map((stop) => (
          <button
            key={stop.nodeId}
            className="resume-card__row"
            data-testid="resume-card-row"
            onClick={() => onOpen(stop.nodeId)}
          >
            <span className="resume-card__note">{stop.note}</span>
            <span className="resume-card__time">{relativeTime(stop.at, Date.now())}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
