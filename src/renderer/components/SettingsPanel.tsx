import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../state/settings'
import { useEntitlement } from '../state/entitlement'
import { NODE_COLORS } from '../state/workspace'
import type { CustomAgent } from '@shared/types'
import type { PromptInjectionMode } from '@shared/agents/config'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'
import { AgentIcon } from '../lib/agentIcons'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { isAgentEnabled, setAgentEnabled, setDefaultAgent } from '../state/agentAvailability'

interface SettingsPanelProps {
  onClose: () => void
}

/** Right-side settings drawer. Changes are saved immediately. */
export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.nodeTerminal.updates.getVersion().then(setVersion)
  }, [])

  const ent = useEntitlement()
  const [licenseKey, setLicenseKey] = useState('')
  const [upgrading, setUpgrading] = useState(false)

  // Remote access (Pro). Host side: a single pairing offer to hand to a client. Client side:
  // paste a host's offer to connect, which opens the live remote-session mirror of the host's
  // canvas (via the `nodeterm:open-remote-terminal` event the Canvas listens for).
  const [hostOffer, setHostOffer] = useState('')
  const [hostBusy, setHostBusy] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [clientCode, setClientCode] = useState('')
  const [connecting, setConnecting] = useState(false)
  const startHosting = async () => {
    setRemoteError('')
    setHostBusy(true)
    try {
      const { offer } = await window.nodeTerminal.remoteHost.start()
      setHostOffer(offer)
    } catch (err) {
      setRemoteError((err as Error).message)
      setHostBusy(false)
    }
  }
  const stopHosting = async () => {
    await window.nodeTerminal.remoteHost.stop()
    setHostOffer('')
    setHostBusy(false)
  }
  const connectToHost = async () => {
    const code = clientCode.trim()
    if (!code) return
    setRemoteError('')
    setConnecting(true)
    try {
      const connectionId = await window.nodeTerminal.remoteClient.connect(code)
      setClientCode('')
      // Open the live remote-session mirror for this connection (Canvas mounts RemoteSessionView).
      window.dispatchEvent(
        new CustomEvent('nodeterm:open-remote-terminal', { detail: { connectionId } })
      )
      onClose()
    } catch (err) {
      setRemoteError((err as Error).message)
    } finally {
      setConnecting(false)
    }
  }
  useEffect(() => {
    void ent.hydrate()
  }, [])

  const customAgents = settings.customAgents
  const patchAgent = (id: string, patch: Partial<CustomAgent>) =>
    update({ customAgents: customAgents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  const removeAgent = (id: string) =>
    update({ customAgents: customAgents.filter((a) => a.id !== id) })
  const addAgent = () =>
    update({
      customAgents: [
        ...customAgents,
        {
          id: 'custom:' + crypto.randomUUID(),
          label: 'Custom agent',
          launchCmd: '',
          promptInjectionMode: 'argv'
        }
      ]
    })

  return createPortal(
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <h2>Settings</h2>
          <button className="drawer__close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="drawer__body">
          <section>
            <h3>Terminal</h3>
            <label className="set-row">
              <span>Font size</span>
              <input
                type="number"
                min={8}
                max={28}
                value={settings.fontSize}
                onChange={(e) => update({ fontSize: Number(e.target.value) || 13 })}
              />
            </label>
            <label className="set-row">
              <span>Font family</span>
              <input
                type="text"
                value={settings.fontFamily}
                onChange={(e) => update({ fontFamily: e.target.value })}
              />
            </label>
            <label className="set-row">
              <span>Cursor blink</span>
              <input
                type="checkbox"
                checked={settings.cursorBlink}
                onChange={(e) => update({ cursorBlink: e.target.checked })}
              />
            </label>
          </section>

          <section>
            <h3>Shell</h3>
            <label className="set-row">
              <span>Default shell</span>
              <input
                type="text"
                placeholder="system default"
                value={settings.defaultShell}
                onChange={(e) => update({ defaultShell: e.target.value })}
              />
            </label>
          </section>

          <section>
            <h3>Behavior</h3>
            <label className="set-row">
              <span>Grid size</span>
              <input
                type="number"
                min={8}
                max={96}
                value={settings.gridSize}
                onChange={(e) => update({ gridSize: Number(e.target.value) || 24 })}
              />
            </label>
            <label className="set-row">
              <span>Snap to grid</span>
              <input
                type="checkbox"
                checked={settings.snapToGrid}
                onChange={(e) => update({ snapToGrid: e.target.checked })}
              />
            </label>
            <label className="set-row">
              <span>Pan-hover delay (ms)</span>
              <input
                type="number"
                min={0}
                max={2000}
                step={50}
                value={settings.panHoverDelay}
                onChange={(e) => update({ panHoverDelay: Number(e.target.value) || 0 })}
              />
            </label>
            <label className="set-row">
              <span>Double-click to focus</span>
              <input
                type="checkbox"
                checked={settings.doubleClickFocus}
                onChange={(e) => update({ doubleClickFocus: e.target.checked })}
              />
            </label>
          </section>

          <section>
            <h3>Claude Code</h3>
            <label className="set-row">
              <span>Notify when a turn finishes in the background</span>
              <input
                type="checkbox"
                checked={settings.notifyOnClaudeDone}
                onChange={(e) => {
                  const on = e.target.checked
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
            </label>
          </section>

          {(() => {
            const rows: { id: AgentId; label: string; isBuiltin: boolean }[] = [
              ...BUILTIN_AGENT_IDS.map((id) => ({ id, label: AGENT_CONFIG[id].label, isBuiltin: true })),
              ...customAgents.map((c) => ({ id: c.id, label: c.label || c.id, isBuiltin: false }))
            ]
            return (
              <section>
                <h3>Agents</h3>
                <p className="set-note">
                  Enable or disable agents in the Add menus, and pick the default (⌘⇧C).
                </p>
                {rows.map((row) => {
                  const enabled = isAgentEnabled(settings, row.id)
                  const isDefault = settings.defaultAgent === row.id
                  return (
                    <div key={row.id} className="agents-row">
                      <span className="agents-row-icon">
                        <AgentIcon agentId={row.id} size={18} />
                      </span>
                      <span className="agents-row-label">{row.label}</span>
                      {row.isBuiltin && (
                        <button
                          type="button"
                          className={`set-btn agents-default${isDefault ? ' active' : ''}`}
                          aria-pressed={isDefault}
                          onClick={() => update(setDefaultAgent(settings, row.id))}
                        >
                          {isDefault ? 'Default' : 'Set default'}
                        </button>
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
              </section>
            )
          })()}

          <section>
            <h3>Custom agents</h3>
            <p className="set-note">
              Bring your own agent CLI. Custom agents launch in a terminal and show process /
              title status only (no hooks, branch, or loop).
            </p>
            {customAgents.map((agent) => (
              <div key={agent.id} className="set-agent">
                <label className="set-row">
                  <span>Label</span>
                  <input
                    type="text"
                    placeholder="e.g. Aider"
                    value={agent.label}
                    onChange={(e) => patchAgent(agent.id, { label: e.target.value })}
                  />
                </label>
                <label className="set-row">
                  <span>Launch command</span>
                  <input
                    type="text"
                    placeholder="e.g. aider"
                    value={agent.launchCmd}
                    onChange={(e) => patchAgent(agent.id, { launchCmd: e.target.value })}
                  />
                </label>
                <label className="set-row">
                  <span>Prompt injection</span>
                  <select
                    value={agent.promptInjectionMode}
                    onChange={(e) =>
                      patchAgent(agent.id, {
                        promptInjectionMode: e.target.value as PromptInjectionMode
                      })
                    }
                  >
                    <option value="argv">argv</option>
                    <option value="flag-prompt">flag-prompt</option>
                    <option value="stdin-after-start">stdin-after-start</option>
                  </select>
                </label>
                <button className="set-btn" onClick={() => removeAgent(agent.id)}>
                  Remove
                </button>
              </div>
            ))}
            <button className="set-btn" onClick={addAgent}>
              Add agent
            </button>
          </section>

          <section>
            <h3>Privacy</h3>
            <label className="set-row">
              <span>Send anonymous usage data (version/OS)</span>
              <input
                type="checkbox"
                checked={settings.telemetryEnabled}
                onChange={(e) => update({ telemetryEnabled: e.target.checked })}
              />
            </label>
            <p className="set-note">No personal data. Used only to see which versions are in use.</p>
          </section>

          <section>
            <h3>Appearance</h3>
            <div className="set-row">
              <span>Accent</span>
              <div className="set-swatches">
                {NODE_COLORS.map((c) => (
                  <button
                    key={c}
                    className={settings.accent === c ? 'active' : ''}
                    style={{ background: c }}
                    onClick={() => update({ accent: c })}
                  />
                ))}
              </div>
            </div>
          </section>

          <section>
            <h3>Commit messages (AI)</h3>
            <p className="set-note">
              Runs a local coding-agent CLI read-only on your staged diff (no built-in model).
            </p>
            <label className="set-row">
              <span>Agent</span>
              <select
                value={settings.commitAgent}
                onChange={(e) =>
                  update({ commitAgent: e.target.value as 'claude' | 'codex' | 'custom' })
                }
              >
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="custom">Custom command…</option>
              </select>
            </label>
            {settings.commitAgent === 'custom' && (
              <label className="set-row">
                <span>Command</span>
                <input
                  type="text"
                  placeholder="mycli --flag {prompt}"
                  value={settings.commitAgentCommand}
                  onChange={(e) => update({ commitAgentCommand: e.target.value })}
                />
              </label>
            )}
            <label className="set-col">
              <span>Extra prompt (optional)</span>
              <textarea
                className="set-textarea"
                placeholder="e.g. Use Conventional Commits with gitmoji"
                value={settings.commitExtraPrompt}
                onChange={(e) => update({ commitExtraPrompt: e.target.value })}
              />
            </label>
          </section>

          <section>
            <h3>tmux</h3>
            <p className="set-note">Applies to new terminals / next launch.</p>
            <label className="set-row">
              <span>Persistent sessions (tmux)</span>
              <input
                type="checkbox"
                checked={settings.tmuxEnabled}
                onChange={(e) => update({ tmuxEnabled: e.target.checked })}
              />
            </label>
            <label className="set-row">
              <span>Scrollback lines</span>
              <input
                type="number"
                min={1000}
                max={200000}
                step={1000}
                value={settings.tmuxScrollback}
                onChange={(e) => update({ tmuxScrollback: Number(e.target.value) || 50000 })}
              />
            </label>
          </section>

          <section>
            <h3>Updates</h3>
            <label className="set-row">
              <span>Current version</span>
              <span className="set-value">{version || '…'}</span>
            </label>
            <button
              className="set-btn"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('nodeterm:update-checking'))
                window.nodeTerminal.updates.check()
              }}
            >
              Check for updates
            </button>
            <p className="set-note">Results appear in the update card at the bottom-right.</p>
          </section>

          <section>
            <h3>License</h3>
            {ent.isPremium ? (
              <>
                <p className="set-note">
                  Pro — active
                  {ent.status.expiresAt
                    ? ` until ${new Date(ent.status.expiresAt * 1000).toLocaleDateString()}`
                    : ''}
                  .
                </p>
                <button className="set-btn" onClick={() => void ent.deactivate()}>
                  Deactivate on this device
                </button>
              </>
            ) : (
              <>
                <button
                  className="set-btn"
                  onClick={() => {
                    setUpgrading(true)
                    void ent.upgrade()
                  }}
                >
                  Upgrade to Pro — $29/mo
                </button>
                {upgrading ? (
                  <p className="set-note">
                    Complete your purchase in the browser — Pro unlocks here automatically.
                  </p>
                ) : (
                  <p className="set-note">Unlock remote access and Pro features.</p>
                )}
                <details>
                  <summary className="set-note" style={{ cursor: 'pointer' }}>
                    Have a license key?
                  </summary>
                  <label className="set-row">
                    <span>License key</span>
                    <input
                      type="text"
                      placeholder="paste your key"
                      value={licenseKey}
                      onChange={(e) => setLicenseKey(e.target.value)}
                    />
                  </label>
                  <button
                    className="set-btn"
                    onClick={() => {
                      if (licenseKey.trim()) void ent.activate(licenseKey.trim())
                    }}
                  >
                    Activate
                  </button>
                  {ent.status.error ? (
                    <p className="set-note" style={{ color: '#ff9f0a' }}>
                      Could not activate ({ent.status.error}).
                    </p>
                  ) : null}
                </details>
              </>
            )}
          </section>

          <section>
            <h3>Remote access</h3>
            <p className="set-note">
              Open terminals that run on another machine you own — end-to-end encrypted over the
              relay. Hosting (sharing this machine) is Pro; connecting to a host is free.
            </p>

            <h4 className="set-subhead">Allow remote access</h4>
            {ent.isPremium ? (
              hostOffer ? (
                <>
                  <p className="set-note">
                    Share this pairing code with the other device (single use):
                  </p>
                  <label className="set-row">
                    <span>Pairing code</span>
                    <input type="text" readOnly value={hostOffer} onFocus={(e) => e.target.select()} />
                  </label>
                  <button
                    className="set-btn"
                    onClick={() => window.nodeTerminal.clipboard.writeText(hostOffer)}
                  >
                    Copy code
                  </button>
                  <button className="set-btn" onClick={() => void stopHosting()}>
                    Stop sharing
                  </button>
                </>
              ) : (
                <button className="set-btn" disabled={hostBusy} onClick={() => void startHosting()}>
                  {hostBusy ? 'Starting…' : 'Allow remote access'}
                </button>
              )
            ) : (
              <p className="set-note">
                Hosting this machine requires nodeterm Pro — upgrade above. Connecting to a host
                you were given a code for is free.
              </p>
            )}

            <h4 className="set-subhead">Connect to a host</h4>
            <label className="set-row">
              <span>Pairing code</span>
              <input
                type="text"
                placeholder="paste the host's code"
                value={clientCode}
                onChange={(e) => setClientCode(e.target.value)}
              />
            </label>
            <button
              className="set-btn"
              disabled={connecting || !clientCode.trim()}
              onClick={() => void connectToHost()}
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>

            {remoteError ? (
              <p className="set-note" style={{ color: '#ff9f0a' }}>
                {remoteError}
              </p>
            ) : null}
          </section>
        </div>
      </aside>
    </div>,
    document.body
  )
}
