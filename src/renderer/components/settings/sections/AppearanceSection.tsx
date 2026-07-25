import { useSettings } from '../../../state/settings'
import { NODE_COLORS } from '../../../state/workspace'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { cn } from '@renderer/ui/cn'

const ROWS = {
  accent: { title: 'Accent', keywords: ['accent', 'color', 'theme', 'appearance'] }
}
const ENTRIES = Object.values(ROWS)

export function AppearanceSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const accent = useSettings((s) => s.settings.accent)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.accent}>
        <div className="flex items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-text">Accent</span>
          <div className="flex flex-wrap gap-2">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${c}`}
                onClick={() => update({ accent: c })}
                style={{ background: c }}
                className={cn(
                  'size-6 rounded-full border-2',
                  accent === c ? 'border-text' : 'border-transparent'
                )}
              />
            ))}
          </div>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
