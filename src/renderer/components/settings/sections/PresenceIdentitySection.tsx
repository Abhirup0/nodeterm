import { useState } from 'react'
import { NAME_MAX_LEN, PRESENCE_COLORS } from '@shared/presence'
import { loadIdentity } from '../../../state/presence'
import { setMeAll } from '../../../session/session'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { thisMachine } from '../../../lib/machineName'

const ROWS = {
  identity: {
    title: 'Your name',
    keywords: ['name', 'presence', 'identity', 'display', 'collaborate', 'color', 'facepile', 'nickname']
  }
}
const ENTRIES = Object.values(ROWS)

/**
 * Edit the live-collaboration identity ({name, color}) others see in the facepile / cursor labels /
 * board-log — the same value the first-connect PresenceNamePrompt sets. Seeds from the saved
 * identity (`loadIdentity`) and writes through `setMeAll`, which re-helloes EVERY live session, so a
 * rename reaches connected peers immediately (no reload). Renderer-only: the identity lives in
 * localStorage (`nodeterm.presence.me`), never in settings.json, and is shared across sessions.
 */
export function PresenceIdentitySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const saved = loadIdentity()
  const [name, setName] = useState(saved?.name ?? '')
  const [color, setColor] = useState(saved?.color ?? PRESENCE_COLORS[0])
  const [justSaved, setJustSaved] = useState(false)

  const trimmed = name.trim()
  const dirty = trimmed !== (saved?.name ?? '') || color !== (saved?.color ?? PRESENCE_COLORS[0])

  const save = (): void => {
    if (!trimmed) return
    // Re-hello every live session (obligation 2): renaming must update every connected core, or a
    // remote peer keeps drawing the old name until reload.
    setMeAll({ name: trimmed, color })
    setJustSaved(true)
  }

  return (
    <SettingsSection
      id="presence"
      title="Your name"
      description={`The name and color other people see when they connect to ${thisMachine()} — in the facepile, cursor labels, and board comments.`}
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.identity}>
        <div className="space-y-4">
          <FieldRow
            label="Display name"
            control={
              <Input
                className="w-72"
                value={name}
                maxLength={NAME_MAX_LEN}
                placeholder="Your name"
                onChange={(e) => {
                  setName(e.target.value)
                  setJustSaved(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save()
                }}
              />
            }
          />
          <FieldRow
            label="Color"
            control={
              <div className="flex flex-wrap gap-2">
                {PRESENCE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    aria-label={`Color ${c}`}
                    onClick={() => {
                      setColor(c)
                      setJustSaved(false)
                    }}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: c,
                      cursor: 'pointer',
                      border: '2px solid transparent',
                      outline: c === color ? '2px solid var(--text)' : 'none',
                      outlineOffset: 2
                    }}
                  />
                ))}
              </div>
            }
          />
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!trimmed || !dirty} onClick={save}>
              Save
            </Button>
            {justSaved && !dirty ? <span className="text-sm text-muted">Saved</span> : null}
          </div>
          <p className="text-sm text-muted">
            If you never pick a name you appear to others as “Someone”. This is separate from your
            login or license — it only labels you during live collaboration.
          </p>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
