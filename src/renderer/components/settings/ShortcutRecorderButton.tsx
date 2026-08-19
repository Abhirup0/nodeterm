/**
 * Generalized shortcut recorder: click to arm, press a chord. Keyed chords commit on keydown;
 * for allowHoldChord commands a modifier-only chord commits on full release (hold-to-talk).
 * While armed it sets data-shortcut-recording (the window dispatcher bails on it via
 * defaultPrevented — every key here is preventDefault'ed). The main-process recording bit
 * (so ⌘W/⌘M/⌘0 interception cannot swallow the capture) is Task 5's: `window.nodeTerminal
 * .shortcuts` does not exist on `NodeTerminalApi` yet, and that type lives in
 * `src/shared/types.ts` — a file this task does not own. An optional-chained call does NOT
 * typecheck against a member the interface never declares, so the two calls are marked below
 * rather than shipped broken.
 */
import { useRef, useState } from 'react'
import { COMMANDS_BY_ID, normalizeBindingForCommand, type CommandId } from '@shared/keybindings'
import { isMacPlatform } from '@shared/platform-utils'
import { recordingKeydown, recordingKeyup, type RecordingState } from './shortcutRecording'

const isMac = isMacPlatform()

export function ShortcutRecorderButton({
  commandId,
  idleLabel,
  onCommit
}: {
  commandId: CommandId
  idleLabel: string
  onCommit: (combo: string) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [hint, setHint] = useState('')
  const stateRef = useRef<RecordingState>({ mods: null })
  const def = COMMANDS_BY_ID.get(commandId)!
  const opts = { isMac, allowHold: def.allowHoldChord === true }

  const stop = (): void => {
    setCapturing(false)
    setHint('')
    stateRef.current = { mods: null }
    // Task 5 wires the main-process recording bit here: setRecording(false)
  }
  const start = (): void => {
    stateRef.current = { mods: null }
    setCapturing(true)
    setHint('')
    // Task 5 wires the main-process recording bit here: setRecording(true)
  }
  const commit = (combo: string): void => {
    const r = normalizeBindingForCommand(def, combo, isMac)
    if (!r.ok) {
      setHint(r.error)
      return
    }
    onCommit(r.value)
    stop()
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    const action = recordingKeydown(stateRef.current, e, opts)
    if (action.kind === 'cancel') stop()
    else if (action.kind === 'commit') commit(action.combo)
    else if (action.kind === 'pending') {
      stateRef.current = action.state
      setHint(action.hint)
    }
  }
  const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    const action = recordingKeyup(stateRef.current, e, opts)
    if (action.kind === 'commit') commit(action.combo)
  }
  return (
    <button
      type="button"
      data-shortcut-recording={capturing || undefined}
      className="min-w-[120px] cursor-pointer rounded-md border border-border bg-panel-header px-3 py-1.5 text-[13px] font-medium text-text outline-none hover:bg-[rgba(255,255,255,0.06)]"
      onClick={start}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={stop}
    >
      {capturing ? hint || 'Press keys…' : idleLabel}
    </button>
  )
}
