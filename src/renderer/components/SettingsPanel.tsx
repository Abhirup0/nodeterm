import { createPortal } from 'react-dom'
import { useSettings } from '../state/settings'
import { NODE_COLORS } from '../state/workspace'

interface SettingsPanelProps {
  onClose: () => void
}

/** Right-side settings drawer. Changes are saved immediately. */
export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

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
                onChange={(e) =>
                  update({ notifyOnClaudeDone: e.target.checked, notifyConsentAsked: true })
                }
              />
            </label>
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
        </div>
      </aside>
    </div>,
    document.body
  )
}
