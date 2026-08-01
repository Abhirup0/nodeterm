import type { KanbanLabel } from '@shared/types'
import { labelSwatch } from '../../lib/kanbanLabelColors'

/** Renders a set of resolved board labels as colored pills. `size` tunes the padding/font for the
 *  card face (sm) vs the modal / node body (md). Display-only — editing lives in LabelPicker. */
export function LabelChips({
  labels,
  size = 'sm',
  className = ''
}: {
  labels: KanbanLabel[]
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element | null {
  if (!labels.length) return null
  return (
    <div className={`kanban-labels kanban-labels--${size} ${className}`.trim()}>
      {labels.map((l) => {
        const s = labelSwatch(l.color)
        return (
          <span key={l.id} className="kanban-label-chip" style={{ background: s.bg, color: s.fg }}>
            {l.name || 'Label'}
          </span>
        )
      })}
    </div>
  )
}
