import { cn } from '@renderer/ui/cn'
import { Input } from '@renderer/ui/Input'
import { SETTINGS_GROUPS, type SettingsSectionId } from './nav'
import { matchesQuery } from './search'

export function SettingsSidebar({
  activeSectionId,
  query,
  onSelect,
  onQueryChange,
  onClose
}: {
  activeSectionId: SettingsSectionId
  query: string
  onSelect: (id: SettingsSectionId) => void
  onQueryChange: (q: string) => void
  onClose: () => void
}): React.JSX.Element {
  const hasQuery = query.trim() !== ''
  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-[15px] font-semibold text-text">Settings</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="text-lg leading-none text-muted hover:text-text"
        >
          ×
        </button>
      </div>
      <div className="border-b border-border p-3">
        <Input
          className="w-full"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search settings"
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-3">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.id} className="mb-4">
            <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-2">
              {group.title}
            </p>
            {group.sections.map((s) => {
              const isActive = activeSectionId === s.id
              const dimmed = hasQuery && !matchesQuery(query, { title: s.title })
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                    isActive
                      ? 'bg-accent text-white'
                      : 'text-text hover:bg-[rgba(255,255,255,0.06)]',
                    dimmed && 'opacity-40'
                  )}
                >
                  {s.title}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </aside>
  )
}
