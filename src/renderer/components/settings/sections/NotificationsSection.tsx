import { useState } from 'react'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'

const ROWS = {
  notify: {
    title: 'Notify when a turn finishes in the background',
    keywords: ['notify', 'notification', 'claude', 'background', 'turn', 'done']
  },
  mobilePush: {
    title: 'Send push notifications to your paired phone',
    keywords: ['push', 'phone', 'mobile', 'apns', 'ios', 'notification', 'approval', 'question', 'done', 'completed', 'needs you', 'live activity', 'live activities', 'dynamic island', 'lock screen']
  }
}
const ENTRIES = Object.values(ROWS)

export function NotificationsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notifyOnClaudeDone = useSettings((s) => s.settings.notifyOnClaudeDone)
  const mobilePushEnabled = useSettings((s) => s.settings.mobilePushEnabled)
  const mobilePushNeedsYou = useSettings((s) => s.settings.mobilePushNeedsYou)
  const mobilePushDone = useSettings((s) => s.settings.mobilePushDone)
  const mobileLiveActivities = useSettings((s) => s.settings.mobileLiveActivities)
  const update = useSettings((s) => s.update)
  // The OS refused our test notification (macOS permission denied). macOS never re-prompts
  // once the app's record exists, so the only way back is the System Settings pane.
  const [osBlocked, setOsBlocked] = useState(false)
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
                setOsBlocked(false)
                // Enabling fires a real test notification: on a fresh install this is what
                // triggers the macOS permission prompt; on a denied/stale record the OS
                // rejects it and we surface the repair path below.
                if (on)
                  void window.nodeTerminal
                    .notify({
                      title: 'Notifications enabled',
                      body: "You'll be told when Claude Code finishes in the background.",
                      nodeId: '',
                      force: true
                    })
                    .then((result) => setOsBlocked(result === 'failed'))
              }}
            />
          }
        />
        {osBlocked && (
          <div className="mt-2 flex items-center gap-3 text-[13px] text-[#ffd60a]">
            macOS is blocking notifications for this app.
            <Button onClick={() => void window.nodeTerminal.openNotificationSettings()}>
              Open System Settings
            </Button>
          </div>
        )}
      </SearchableRow>
      <SearchableRow {...ROWS.mobilePush}>
        <FieldRow
          label="Send push notifications to your paired phone"
          description="Fires when an agent needs approval, asks a question, or finishes — only if you've paired a phone."
          control={
            <Switch
              checked={mobilePushEnabled}
              ariaLabel="Mobile push notifications"
              onChange={(on) => update({ mobilePushEnabled: on })}
            />
          }
        />
        {/* Per-kind sub-gates. Inert (dimmed, non-interactive) while the master toggle is off. */}
        <div
          className={
            'mt-3 space-y-3 border-l border-white/10 pl-4' +
            (mobilePushEnabled ? '' : ' pointer-events-none opacity-40')
          }
          aria-disabled={!mobilePushEnabled}
        >
          <FieldRow
            label="Needs you (approvals & questions)"
            control={
              <Switch
                checked={mobilePushNeedsYou}
                ariaLabel="Push when an agent needs you"
                onChange={(on) => update({ mobilePushNeedsYou: on })}
              />
            }
          />
          <FieldRow
            label="Task completed"
            control={
              <Switch
                checked={mobilePushDone}
                ariaLabel="Push when a task completes"
                onChange={(on) => update({ mobilePushDone: on })}
              />
            }
          />
          <FieldRow
            label="Live Activities"
            description="Keep a Lock Screen / Dynamic Island activity updated as a session works, needs you, or finishes."
            control={
              <Switch
                checked={mobileLiveActivities}
                ariaLabel="Live Activities on your phone"
                onChange={(on) => update({ mobileLiveActivities: on })}
              />
            }
          />
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
