import { cn } from '@renderer/ui/cn'
import { Input } from '@renderer/ui/Input'
import { SETTINGS_GROUPS, type SettingsSectionId } from './nav'
import { matchesQuery } from './search'
import { SectionIcon } from './SettingsIcons'

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
    <aside className="flex w-[256px] shrink-0 flex-col border-r border-border bg-panel">
      <div
        className="flex items-center justify-between px-4 pb-2 pt-10"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <h1 className="text-sm font-semibold tracking-tight text-text">Settings</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="flex size-6 items-center justify-center rounded-md border-0 bg-panel text-muted outline-none transition-colors hover:bg-white/10 hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </div>

      <div className="px-3 pb-3">
        <div className="relative">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="6" cy="6" r="4" />
            <path d="M9.2 9.2 12 12" />
          </svg>
          <Input
            className="h-8 w-full pl-8"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.id} className="space-y-0.5">
            <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-2">
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
                    'group flex w-full items-center gap-2.5 rounded-lg border-0 px-3 py-2 text-left text-[13px] outline-none transition-colors',
                    isActive
                      ? 'bg-white/[0.09] font-medium text-text ring-1 ring-inset ring-white/10'
                      : 'bg-panel text-muted hover:bg-white/[0.05] hover:text-text',
                    dimmed && 'opacity-35'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center transition-colors',
                      isActive ? 'text-text' : 'text-muted-2 group-hover:text-muted'
                    )}
                  >
                    <SectionIcon id={s.id} />
                  </span>
                  <span className="truncate">{s.title}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </aside>
  )
}
