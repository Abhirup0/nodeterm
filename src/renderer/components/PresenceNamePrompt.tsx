import { useState } from 'react'
import { NAME_MAX_LEN, PRESENCE_COLORS } from '@shared/presence'
import { selectOthers, suggestIdentity, usePresence } from '../state/presence'
import { setMeAll } from '../session/session'

/**
 * First-connect identity prompt: pick a name + color. Saved to localStorage
 * (`nodeterm.presence.me`, the only persisted thing in the whole feature), so it is asked exactly
 * once per browser/device.
 *
 * Shown only when someone else is actually connected — a solo user is never interrupted by a
 * dialog for a feature they cannot see. Skipping it leaves you as the hub's default "Someone" with
 * the color it assigned you: presence still works, you are just anonymous.
 *
 * PERF: the peer count is a NUMBER derived from the store, so cursor traffic (which never changes
 * the count) cannot re-render this.
 */
export function PresenceNamePrompt(): JSX.Element | null {
  const needsName = usePresence((s) => s.needsName)
  const otherCount = usePresence((s) => selectOthers(s).length)
  // suggestIdentity is read ONCE (lazy initializer): a peer joining later must not swap the
  // suggested color out from under a user who is mid-typing.
  const [draft] = useState(suggestIdentity)
  const [name, setName] = useState(draft.name)
  const [color, setColor] = useState(draft.color)
  const [dismissed, setDismissed] = useState(false)

  if (!needsName || dismissed || otherCount === 0) return null

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    // Re-hello EVERY live session, not just the local one (obligation 2): renaming yourself must
    // rename you on every connected core, or a remote peer keeps drawing your old name until reload.
    setMeAll({ name: trimmed, color }) // saves + says hello again on each session
  }

  return (
    <div className="presence-prompt nodrag nowheel">
      <div className="presence-prompt__title">Someone else is on this canvas</div>
      <div className="presence-prompt__body">Pick a name so they know who is who.</div>
      <input
        className="presence-prompt__input"
        autoFocus
        value={name}
        maxLength={NAME_MAX_LEN}
        placeholder="Your name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setDismissed(true)
          e.stopPropagation() // never let canvas shortcuts (delete, ⌘K, "/") see this typing
        }}
      />
      <div className="presence-prompt__colors">
        {PRESENCE_COLORS.map((c) => (
          <button
            key={c}
            className={`presence-prompt__swatch${c === color ? ' presence-prompt__swatch--on' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="presence-prompt__actions">
        <button className="presence-prompt__skip" onClick={() => setDismissed(true)}>
          Skip
        </button>
        <button className="presence-prompt__ok" disabled={!name.trim()} onClick={submit}>
          Join
        </button>
      </div>
    </div>
  )
}

export default PresenceNamePrompt
