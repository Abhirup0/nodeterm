import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  notify: {
    title: 'Notify when a turn finishes in the background',
    keywords: ['notify', 'notification', 'claude', 'background', 'turn', 'done']
  }
}
const ENTRIES = Object.values(ROWS)

export function NotificationsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notifyOnClaudeDone = useSettings((s) => s.settings.notifyOnClaudeDone)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="notifications"
      title="Notifications"
      description="Get notified when an agent finishes while the app is in the background."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.notify}>
        <FieldRow
          label="Notify when a turn finishes in the background"
          control={
            <Switch
              checked={notifyOnClaudeDone}
              ariaLabel="Background notifications"
              onChange={(on) => {
                update({ notifyOnClaudeDone: on, notifyConsentAsked: true })
                // Enabling triggers the macOS notification permission prompt.
                if (on)
                  void window.nodeTerminal.notify({
                    title: 'Notifications enabled',
                    body: "You'll be told when Claude Code finishes in the background.",
                    nodeId: '',
                    force: true
                  })
              }}
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
