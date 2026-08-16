import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'

const ROWS = {
  logPanel: {
    title: 'Debug log panel',
    keywords: ['debug', 'log', 'logs', 'console', 'diagnostics', 'troubleshoot']
  }
}
const ENTRIES = Object.values(ROWS)

export function DebugSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const debugLogPanel = useSettings((s) => s.settings.debugLogPanel)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="debug" title="Debug" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.logPanel}>
        <FieldRow
          label="Debug log panel"
          description="Captures the app's own console into an in-memory ring (secrets redacted at capture) and unlocks the log viewer — also in the command palette as “Show debug log”. Nothing is written to disk or sent anywhere; export is manual copy."
          control={
            <Switch
              checked={debugLogPanel}
              onChange={(v) => update({ debugLogPanel: v })}
              ariaLabel="Debug log panel"
            />
          }
        />
        {debugLogPanel && (
          <FieldRow
            label="Log viewer"
            description="Live view of the ring, with level and text filters."
            control={
              <Button
                onClick={() =>
                  // Canvas listens; the settings dialog closes itself so the panel is visible.
                  window.dispatchEvent(new CustomEvent('nodeterm:open-log-panel'))
                }
              >
                Open
              </Button>
            }
          />
        )}
      </SearchableRow>
    </SettingsSection>
  )
}
