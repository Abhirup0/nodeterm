import { useEffect, useState } from 'react'
import { useSettings } from '../../../state/settings'
import {
  isAgentEnabled,
  setAgentEnabled,
  setDefaultAgent
} from '../../../state/agentAvailability'
import { ensureClaudeCliCaps } from '../../../state/permissionMode'
import type { ClaudeCliCaps } from '@shared/types'
import {
  AGENT_CONFIG,
  ALL_PERMISSION_MODES,
  AUTO_PERMISSION_MODE_MIN_VERSION,
  BUILTIN_AGENT_IDS,
  PERMISSION_MODE_LABELS,
  type AgentId,
  type AgentPermissionMode
} from '@shared/agents/config'
import { AgentIcon } from '../../../lib/agentIcons'
import { hintLabel } from '@shared/platform-utils'
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
  },
  cookieProviders: {
    title: 'Usage from web consoles',
    keywords: [
      'minimax',
      'opencode',
      'usage',
      'quota',
      'cookie',
      'limits',
      'provider',
      'session'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

/**
 * Providers that publish no CLI credential — their quota lives behind a web console session, so
 * the user pastes a cookie. Each row is write-only: it can store or clear a value and can see
 * WHETHER one is stored, but the secret is never read back into the UI.
 */
const COOKIE_PROVIDER_ROWS = [
  {
    id: 'minimax',
    label: 'MiniMax',
    description:
      "MiniMax exposes no CLI credential, so its quota is read with your console session. Open platform.minimax.io/console/usage, copy the request's Cookie header from DevTools, and paste it here.",
    placeholder: 'Cookie: _token=…'
  },
  {
    id: 'opencode',
    label: 'opencode',
    description:
      'opencode publishes no usage API, so the numbers are read from your dashboard page. Open opencode.ai, copy the Cookie header from DevTools, and paste it here. Because this reads a page rather than an API, it can stop working when opencode changes their site — it will report an error rather than silently showing nothing.',
    placeholder: 'auth=…'
  }
] as const

function CookieProviderRow({
  id,
  label,
  description,
  placeholder,
  stored,
  onChange
}: {
  id: string
  label: string
  description: string
  placeholder: string
  stored: boolean
  onChange: (stored: boolean) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const save = async (next: string): Promise<void> => {
    onChange(await window.nodeTerminal.usage.setProviderCookie(id, next))
    // Never keep the secret in component state once it has been handed over.
    setValue('')
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={
        stored
          ? 'Stored in a file only your user can read, never in settings.json. It is not shown again — paste a fresh one when your session expires.'
          : 'This is a live session credential. It is stored in a 0600 file, not in settings.json, and is never read back into the UI.'
      }
      control={
        <div className="flex items-center gap-2">
          <input
            type="password"
            className="input w-64"
            placeholder={stored ? '•••••••• stored' : placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button onClick={() => void save(value)} disabled={!value.trim()}>
            Save
          </Button>
          {stored && <Button onClick={() => void save('')}>Clear</Button>}
        </div>
      }
    />
  )
}

export function AgentsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  // Cookie-based providers are write-only across the IPC boundary: we can ask WHICH have one
  // stored and set/clear them, but never read a value back — so an input starts empty even when
  // one is configured, and is cleared the moment it is handed over.
  const [cookieStored, setCookieStored] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    void window.nodeTerminal.usage.cookieProviders().then((v) => {
      if (!cancelled) setCookieStored(v)
    })
    return () => {
      cancelled = true
    }
  }, [isActive])

  const rows: { id: AgentId; label: string; isBuiltin: boolean }[] = [
    ...BUILTIN_AGENT_IDS.map((id) => ({ id, label: AGENT_CONFIG[id].label, isBuiltin: true })),
    ...settings.customAgents.map((c) => ({ id: c.id, label: c.label || c.id, isBuiltin: false }))
  ]

  // The LOCAL Claude CLI's capabilities (the same memoized probe the launch path uses — no extra
  // IPC). `Auto` is silently dropped on a CLI older than the floor (it exits 1 on the flag), and a
  // setting that quietly does nothing reads as a broken setting — so say it where it's picked.
  // Remote (SSH) projects run their own CLI; this note is about the machine running the app.
  const [cliCaps, setCliCaps] = useState<ClaudeCliCaps | null>(null)
  useEffect(() => {
    let alive = true
    void ensureClaudeCliCaps().then((c) => {
      if (alive) setCliCaps(c)
    })
    return () => {
      alive = false
    }
  }, [])
  // Only when the probe actually READ a version: an unknown version (probe failed / no CLI) is not
  // evidence of an old CLI, and guessing would be its own kind of wrong.
  const autoNote =
    settings.claudePermissionMode === 'auto' && cliCaps?.version && !cliCaps.autoPermissionMode
      ? `Your Claude CLI (${cliCaps.version.split(/\s+/)[0]}) doesn't support Auto — sessions start in "${PERMISSION_MODE_LABELS.manual}". Requires Claude Code ${AUTO_PERMISSION_MODE_MIN_VERSION} or newer.`
      : undefined

  return (
    <SettingsSection
      id="agents"
      title="Agents"
      description={hintLabel('Enable or disable agents in the Add menus, and pick the default (⌘⇧C).')}
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
      <SearchableRow {...ROWS.cookieProviders}>
        {COOKIE_PROVIDER_ROWS.map((p) => (
          <CookieProviderRow
            key={p.id}
            {...p}
            stored={!!cookieStored[p.id]}
            onChange={(stored) => setCookieStored((m) => ({ ...m, [p.id]: stored }))}
          />
        ))}
      </SearchableRow>
      <SearchableRow {...ROWS.permissionMode}>
        <FieldRow
          label="Permission mode"
          note={autoNote}
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
