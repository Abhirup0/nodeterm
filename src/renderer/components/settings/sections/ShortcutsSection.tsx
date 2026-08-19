/**
 * The Keyboard Shortcuts settings section: one row per registry command, with its live chips,
 * a recorder, and Add / Disable / Reset.
 *
 * **The pre-save gate is `commitCandidate`, and it is where the refusal messages are decided.**
 * Design D3 is "same detector, different surfacing": `sanitizeKeybindingOverrides` applies what
 * survives on LOAD, while this section refuses a bad candidate BEFORE anything is written, so the
 * user learns which chord was refused and why instead of watching a saved shortcut disappear on
 * the next launch. Three checks, in this order, and the order is the whole dedupe:
 *   1. `normalizeBindingForCommand` — already inside `ShortcutRecorderButton`, so an invalid chord
 *      never reaches `onCommit` (its own hint is shown in the recorder button itself).
 *   2. `findKeybindingConflicts` over the candidate map — a same-bucket collision.
 *   3. `findMainInterceptShadowing` — a CROSS-bucket hit the conflict check cannot see.
 * (2) returns early, so a candidate that trips both detectors (a main-intercepted command taking
 * a chord another GLOBAL command already holds — `node.close` ← `Cmd+K`) produces exactly ONE
 * message. The shadow message is reserved for what only it can see: `node.close` ← `Cmd+F`, where
 * the two commands live in different buckets and nothing collides, yet main swallows the key
 * before the terminal surface is ever offered it.
 *
 * Writes go through `setKeybindingOverride` (the single write path — it also mirrors
 * `speech.dictation` into the legacy `settings.speech.shortcut` field for one release).
 */
import { useMemo, useState } from 'react'
import {
  COMMANDS_BY_ID,
  COMMAND_DEFINITIONS,
  findKeybindingConflicts,
  findMainInterceptShadowing,
  type CommandDefinition,
  type CommandGroup,
  type CommandId
} from '@shared/keybindings'
import { formatShortcut } from '@shared/shortcut'
import { isMacPlatform, keyLabel } from '@shared/platform-utils'
import {
  activeKeybindingOverrides,
  commandKeysFor,
  effectiveBindings,
  setKeybindingOverride
} from '../../../lib/keybindingOverrides'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ShortcutRecorderButton } from '../ShortcutRecorderButton'
import { Button } from '@renderer/ui/Button'
import type { SettingsSearchEntry } from '../search'

/** Per-command help text. Only commands whose BEHAVIOR needs explaining get one — a row that
 *  merely repeats its own title is noise in a 20-row list. */
const NOTES: Partial<Record<CommandId, string>> = {
  // Reused verbatim from the old SpeechSection row: the mode is derived from the chord's SHAPE,
  // which is not guessable from a chip.
  'speech.dictation':
    'With a key = toggle (press to start, press again to stop and insert); modifiers only = hold to talk (hold to record, release to stop and insert). The Dock mic uses the same shortcut.',
  'canvas.deleteSelection': 'Bare keys are allowed here; the typing guard keeps Backspace safe.',
  'terminal.copySelection': 'Applies to a selection xterm owns — a tmux drag copies through OSC 52.'
}

function rowEntry(def: CommandDefinition): SettingsSearchEntry {
  return {
    title: def.title,
    description: NOTES[def.id],
    keywords: ['shortcut', 'keybinding', 'hotkey', 'key', def.group, def.id]
  }
}

function groupEntry(group: CommandGroup, defs: CommandDefinition[]): SettingsSearchEntry {
  // The header must survive any query that keeps one of its rows, so its keywords are the union
  // of what those rows match on — otherwise a filtered list shows rows under the wrong heading.
  return {
    title: group,
    keywords: ['shortcut', 'keybinding', 'hotkey', ...defs.flatMap((d) => [d.title, d.id])]
  }
}

/**
 * The testable core the row controls delegate to: gate a candidate binding, then write it.
 * `mode` is `'replace'` (the recorder's primary action) or `'add'` (a second chord for the same
 * command). Re-adding a chord the command already holds is idempotent rather than a
 * self-conflict — it is filtered out of the list before being appended.
 *
 * Assumes `combo` is already canonical: `ShortcutRecorderButton` runs
 * `normalizeBindingForCommand` and never emits an invalid chord.
 */
export function commitCandidate(
  id: CommandId,
  combo: string,
  mode: 'replace' | 'add'
): { ok: true } | { ok: false; error: string } {
  const isMac = isMacPlatform()
  const current = activeKeybindingOverrides()
  const existing = effectiveBindings(id)
  const nextList = mode === 'add' ? [...existing.filter((b) => b !== combo), combo] : [combo]
  const chord = formatShortcut(combo, isMac)

  const conflicts = findKeybindingConflicts({ ...current, [id]: nextList }, isMac).filter((c) =>
    c.commandIds.includes(id)
  )
  if (conflicts.length) {
    const titles = [
      ...new Set(
        conflicts
          .flatMap((c) => c.commandIds)
          .filter((cid) => cid !== id)
          .map((cid) => COMMANDS_BY_ID.get(cid)?.title ?? cid)
      )
    ]
    return { ok: false, error: `${chord} is already used by ${titles.join(', ')}.` }
  }

  const shadowed = findMainInterceptShadowing(id, combo, current, isMac)
  if (shadowed.length) {
    const titles = shadowed.map((cid) => COMMANDS_BY_ID.get(cid)?.title ?? cid).join(', ')
    return { ok: false, error: `${chord} would be swallowed app-wide before ${titles} could see it.` }
  }

  setKeybindingOverride(id, nextList)
  return { ok: true }
}

function Chips({ id }: { id: CommandId }): React.JSX.Element {
  const keys = commandKeysFor(id)
  if (keys.length === 0) return <></>
  return (
    <span className="flex items-center gap-2">
      {keys.map((parts, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 ? <span className="text-[11px] text-muted">or</span> : null}
          {parts.map((p, j) => (
            <kbd key={j} className="kbd">
              {keyLabel(p)}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

export function ShortcutsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  // Any remap re-renders every row: chips, and the Add/Disable/Reset visibility, are all derived
  // from the override map.
  const overrides = useSettings((s) => s.settings.keybindings)
  const [errors, setErrors] = useState<Partial<Record<CommandId, string>>>({})

  const groups = useMemo(() => {
    const byGroup = new Map<CommandGroup, CommandDefinition[]>()
    for (const def of COMMAND_DEFINITIONS) {
      byGroup.set(def.group, [...(byGroup.get(def.group) ?? []), def])
    }
    return [...byGroup.entries()]
  }, [])

  const entries = useMemo(
    () => [
      ...groups.map(([group, defs]) => groupEntry(group, defs)),
      ...COMMAND_DEFINITIONS.map(rowEntry)
    ],
    [groups]
  )

  const apply = (id: CommandId, combo: string, mode: 'replace' | 'add'): void => {
    const r = commitCandidate(id, combo, mode)
    setErrors((prev) => ({ ...prev, [id]: r.ok ? undefined : r.error }))
  }
  const write = (id: CommandId, bindings: readonly string[] | null): void => {
    setKeybindingOverride(id, bindings)
    setErrors((prev) => ({ ...prev, [id]: undefined }))
  }

  return (
    <SettingsSection
      id="shortcuts"
      title="Keyboard Shortcuts"
      description="Remap any command. Overrides are stored in settings.json under `keybindings`; Disable turns a command's shortcut off, Reset restores its default. macOS owns ⌘M for Window ▸ Minimize, so that one chord cannot be recorded here."
      isActive={isActive}
      searchEntries={entries}
    >
      {groups.map(([group, defs]) => (
        <div key={group} className="space-y-4">
          <SearchableRow {...groupEntry(group, defs)}>
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">
              {group}
            </h3>
          </SearchableRow>
          {defs.map((def) => {
            const override = overrides?.[def.id]
            const disabled = Array.isArray(override) && override.length === 0
            const bound = commandKeysFor(def.id).length > 0
            return (
              <SearchableRow key={def.id} {...rowEntry(def)}>
                <div data-command={def.id}>
                  <FieldRow
                    label={def.title}
                    description={NOTES[def.id]}
                    note={errors[def.id]}
                    control={
                      <div className="flex items-center gap-2">
                        {bound ? (
                          <Chips id={def.id} />
                        ) : (
                          <span className="text-[13px] text-muted">
                            {disabled ? 'Disabled' : '—'}
                          </span>
                        )}
                        <ShortcutRecorderButton
                          commandId={def.id}
                          idleLabel={bound ? 'Record' : 'Record shortcut'}
                          onCommit={(combo) => apply(def.id, combo, 'replace')}
                        />
                        {bound ? (
                          <ShortcutRecorderButton
                            commandId={def.id}
                            idleLabel="Add"
                            onCommit={(combo) => apply(def.id, combo, 'add')}
                          />
                        ) : null}
                        {bound ? (
                          <Button
                            variant="ghost"
                            aria-label={`Disable ${def.title}`}
                            onClick={() => write(def.id, [])}
                          >
                            Disable
                          </Button>
                        ) : null}
                        {override !== undefined ? (
                          <Button
                            variant="ghost"
                            aria-label={`Reset ${def.title}`}
                            onClick={() => write(def.id, null)}
                          >
                            Reset
                          </Button>
                        ) : null}
                      </div>
                    }
                  />
                </div>
              </SearchableRow>
            )
          })}
        </div>
      ))}
    </SettingsSection>
  )
}
