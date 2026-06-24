import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'

const ROWS = {
  enabled: {
    title: 'Persistent sessions (tmux)',
    keywords: ['tmux', 'persistent', 'session', 'continuity']
  },
  scrollback: { title: 'Scrollback lines', keywords: ['tmux', 'scrollback', 'history', 'lines'] }
}
const ENTRIES = Object.values(ROWS)

export function TmuxSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="tmux"
      title="tmux"
      description="Applies to new terminals / next launch."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enabled}>
        <FieldRow
          label="Persistent sessions (tmux)"
          control={
            <Switch
              checked={settings.tmuxEnabled}
              onChange={(v) => update({ tmuxEnabled: v })}
              ariaLabel="Persistent sessions"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.scrollback}>
        <FieldRow
          label="Scrollback lines"
          control={
            <NumberField
              value={settings.tmuxScrollback}
              min={1000}
              max={200000}
              step={1000}
              onChange={(v) => update({ tmuxScrollback: v || 50000 })}
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
