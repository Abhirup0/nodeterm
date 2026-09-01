import { KANBAN_SOURCES, type KanbanSourceFilter as KanbanSourceFilterValue } from '../../lib/kanbanSources'

/** The filter's value: every source, or one of them. Named for its call sites, which read it as
 *  "which source is the board showing". */
export type KanbanSource = KanbanSourceFilterValue

export function KanbanSourceFilter({
  value,
  onChange
}: {
  value: KanbanSource
  onChange: (value: KanbanSource) => void
}): React.JSX.Element {
  // 'all' plus the registry, in declaration order — adding a source adds a button here.
  const options: { id: KanbanSource; label: string }[] = [
    { id: 'all', label: 'All' },
    ...KANBAN_SOURCES.map((source) => ({ id: source.id as KanbanSource, label: source.label }))
  ]
  return (
    <div className="kanban-source-filter" role="group" aria-label="Card source">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={value === option.id ? 'kanban-source-filter__button is-active' : 'kanban-source-filter__button'}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
