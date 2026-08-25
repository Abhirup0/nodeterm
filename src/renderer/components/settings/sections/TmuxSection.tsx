import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'
import {
  LEAD_PANE_WIDTH_DEFAULT,
  LEAD_PANE_WIDTH_MAX,
  LEAD_PANE_WIDTH_MIN
} from '@shared/tmux-lead-pane'

const ROWS = {
  enabled: {
    title: 'Persistent sessions (tmux)',
    keywords: ['tmux', 'persistent', 'session', 'continuity']
  },
  scrollback: { title: 'Scrollback lines', keywords: ['tmux', 'scrollback', 'history', 'lines'] },
  leadPane: {
    title: 'Keep lead pane wide (agent teams)',
    keywords: ['lead', 'pane', 'width', 'agent', 'team', 'teammates', 'split', 'claude', 'resize']
  },
  offscreen: {
    title: 'Release offscreen terminals',
    keywords: ['offscreen', 'memory', 'ram', 'release', 'reattach', 'idle', 'minutes']
  }
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
      <SearchableRow {...ROWS.leadPane}>
        <FieldRow
          label="Keep lead pane wide (agent teams)"
          description={
            'Claude Code agent teams re-apply a hardcoded 70/30 tmux split on every teammate spawn, squeezing the pane you type into. ' +
            'When on, guarded tmux hooks keep the lead pane at the chosen % of the node width (40–90), locally and on SSH hosts (at next connect). ' +
            'Side effect: a manual 50/50 split in a plain terminal is nudged to the same width. ' +
            'Turning it off leaves a running tmux server’s hooks in place until that server exits (close all terminals, or tmux -L node-terminal kill-server).'
          }
          control={
            <div className="flex items-center gap-2">
              {settings.tmuxLeadPaneWidth > 0 ? (
                <NumberField
                  value={settings.tmuxLeadPaneWidth}
                  min={LEAD_PANE_WIDTH_MIN}
                  max={LEAD_PANE_WIDTH_MAX}
                  step={1}
                  ariaLabel="Lead pane width (%)"
                  // Raw value stored; out-of-range hand edits are re-validated where the conf is
                  // generated (sanitizeLeadPaneWidth), so mid-typing values never snap under the
                  // user's cursor.
                  onChange={(v) => update({ tmuxLeadPaneWidth: Number.isFinite(v) ? v : 0 })}
                />
              ) : null}
              <Switch
                checked={settings.tmuxLeadPaneWidth > 0}
                onChange={(v) => update({ tmuxLeadPaneWidth: v ? LEAD_PANE_WIDTH_DEFAULT : 0 })}
                ariaLabel="Keep lead pane wide"
              />
            </div>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.offscreen}>
        <FieldRow
          label="Release offscreen terminals"
          description="Minutes a terminal may sit offscreen before its view is released (tmux keeps it running; it reattaches on view). 0 = never."
          control={
            <NumberField
              value={settings.offscreenTerminalMinutes}
              min={0}
              max={240}
              step={1}
              // A cleared/invalid field reads back as 0 = "never", the safe end of this setting.
              // Never NaN: `offscreenDisposeMs` would read it as "off" anyway, but NaN does not
              // survive a JSON round-trip to settings.json (it lands as `null`).
              onChange={(v) =>
                update({ offscreenTerminalMinutes: Number.isFinite(v) ? Math.max(0, v) : 0 })
              }
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
