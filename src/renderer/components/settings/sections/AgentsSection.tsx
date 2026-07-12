import { useSettings } from '../../../state/settings'
import {
  isAgentEnabled,
  setAgentEnabled,
  setDefaultAgent
} from '../../../state/agentAvailability'
import {
  AGENT_CONFIG,
  ALL_PERMISSION_MODES,
  BUILTIN_AGENT_IDS,
  PERMISSION_MODE_LABELS,
  type AgentId,
  type AgentPermissionMode
} from '@shared/agents/config'
import { AgentIcon } from '../../../lib/agentIcons'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { Button } from '@renderer/ui/Button'
import { Select } from '@renderer/ui/Select'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'

const ROWS = {
  agents: {
    title: 'Agents',
    keywords: ['agent', 'claude', 'codex', 'gemini', 'enable', 'disable', 'default']
  },
  permissionMode: {
    title: 'Permission mode',
    keywords: [
      'permission',
      'mode',
      'auto',
      'auto mode',
      'accept edits',
      'plan',
      'bypass',
      'approve',
      'ask',
      'claude',
      'shift tab'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

export function AgentsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const rows: { id: AgentId; label: string; isBuiltin: boolean }[] = [
    ...BUILTIN_AGENT_IDS.map((id) => ({ id, label: AGENT_CONFIG[id].label, isBuiltin: true })),
    ...settings.customAgents.map((c) => ({ id: c.id, label: c.label || c.id, isBuiltin: false }))
  ]
  return (
    <SettingsSection
      id="agents"
      title="Agents"
      description="Enable or disable agents in the Add menus, and pick the default (⌘⇧C)."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.agents}>
        <div className="space-y-2">
          {rows.map((row) => {
            const enabled = isAgentEnabled(settings, row.id)
            const isDefault = settings.defaultAgent === row.id
            return (
              <div key={row.id} className="flex items-center gap-3 py-1.5">
                <AgentIcon agentId={row.id} size={18} />
                <span className="flex-1 text-[13px] text-text">{row.label}</span>
                {row.isBuiltin && (
                  <Button
                    variant={isDefault ? 'primary' : 'default'}
                    aria-pressed={isDefault}
                    onClick={() => update(setDefaultAgent(settings, row.id))}
                  >
                    {isDefault ? 'Default' : 'Set default'}
                  </Button>
                )}
                <SegmentedPill<'enabled' | 'disabled'>
                  value={enabled ? 'enabled' : 'disabled'}
                  ariaLabel={`${row.label} availability`}
                  options={[
                    { value: 'enabled', label: 'Enabled' },
                    { value: 'disabled', label: 'Disabled' }
                  ]}
                  onChange={(v) => update(setAgentEnabled(settings, row.id, v === 'enabled'))}
                />
              </div>
            )
          })}
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.permissionMode}>
        <FieldRow
          label="Permission mode"
          description="The mode Claude terminal sessions start in (chat nodes are not affected). Shift+Tab still switches modes at any time. Projects can override this from the tab ⌄ menu."
          control={
            <Select
              aria-label="Claude permission mode"
              value={settings.claudePermissionMode}
              onChange={(e) =>
                update({ claudePermissionMode: e.target.value as AgentPermissionMode })
              }
            >
              {ALL_PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m === 'bypassPermissions'
                    ? `${PERMISSION_MODE_LABELS[m]} ⚠︎`
                    : PERMISSION_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
