/**
 * The Keyboard Shortcuts settings section: one row per registry command, with its live chips,
 * a recorder, and Add / Disable / Reset.
 *
 * **The pre-save gate is `commitCandidate`, and it is where the refusal messages are decided.**
 * Design D3 is "same detector, different surfacing": `sanitizeKeybindingOverrides` applies what
 * survives on LOAD, while this section refuses a bad candidate BEFORE anything is written, so the
 * user learns which chord was refused and why instead of watching a saved shortcut disappear on
 * the next launch. The checks run in this order, and the order is the whole dedupe:
 *   1. `normalizeBindingForCommand` — already inside `ShortcutRecorderButton`, so an invalid chord
 *      never reaches `onCommit` (its own hint is shown in the recorder button itself).
 *   2. `findKeybindingConflicts` over the candidate map — a same-bucket collision.
 *   3. `findMainInterceptShadowing` — a CROSS-bucket hit the conflict check cannot see.
 *   4. REVERSE shadowing — the same collision seen from the non-intercepted side.
 *   5. The two DICTATION overlap gates — the one overlap `conflictBucket` deliberately does not
 *      report, refused here in both directions, but only for `app`/`canvas`-scope commands: the
 *      keyed gesture has a focus gate, so a terminal- or scm-scope command never competes with it
 *      (see the block itself for why).
 * (2) returns early, so a candidate that trips both detectors (a main-intercepted command taking
 * a chord another GLOBAL command already holds — `node.close` ← `Cmd+K`) produces exactly ONE
 * message. The shadow message is reserved for what only it can see: `node.close` ← `Cmd+F`, where
 * the two commands live in different buckets and nothing collides, yet main swallows the key
 * before the terminal surface is ever offered it.
 *
 * Writes go through `setKeybindingOverride` (the single write path — it also mirrors
 * `speech.dictation` into the legacy `settings.speech.shortcut` field for one release).
 */
import { Fragment, useMemo, useState } from 'react'
import {
  bindingIdentity,
  COMMANDS_BY_ID,
  COMMAND_DEFINITIONS,
  findKeybindingConflicts,
  findMainInterceptShadowing,
  MAIN_INTERCEPTED_COMMAND_IDS,
  normalizeTerminalShortcutPolicy,
  type CommandDefinition,
  type CommandGroup,
  type CommandId,
  type TerminalShortcutPolicy
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
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { useSettingsSearch } from '../context'
import { matchesQuery, type SettingsSearchEntry } from '../search'

/** Per-command help text. Only commands whose BEHAVIOR needs explaining get one — a row that
 *  merely repeats its own title is noise in a 20-row list. */
const NOTES: Partial<Record<CommandId, string>> = {
  // Reused verbatim from the old SpeechSection row: the mode is derived from the chord's SHAPE,
  // which is not guessable from a chip.
  'speech.dictation':
    'With a key = toggle (press to start, press again to stop and insert); modifiers only = hold to talk (hold to record, release to stop and insert). The Dock mic uses the same shortcut. A keyed dictation chord is claimed before any other shortcut while the canvas has focus.',
  'canvas.deleteSelection': 'Bare keys are allowed here; the typing guard keeps Backspace safe.',
  'terminal.copySelection': 'Applies to a selection xterm owns — a tmux drag copies through OSC 52.'
}

/** The policy row is NOT a registry command, so it carries its own search entry and its own
 *  `SearchableRow` — putting it inside a group Fragment would make `groupVisible` (which only
 *  knows about commands) decide whether a *setting* is on screen. */
const POLICY_LABEL = 'While a terminal has focus'
const POLICY_DESCRIPTION =
  "App shortcuts first (the default): shared shortcuts like ⌘K keep working over a focused terminal, and the first time one is captured that way the terminal says so — once per chord, ever. Terminal first: every chord but the terminal's own reaches the shell or TUI, including Close (⌘W / Ctrl+W), Minimize (⌘M / Ctrl+M), actual size (⌘0), the kanban board (⌘⇧B), Settings (⌘,) and the ⌘1–9 project jumps — the matching application-menu entries grey out while a terminal is focused, so those chords can reach it. Reload (⌘R / ⌘⇧R) is the one exception and always stays with the app, so a stuck window can still be recovered."
const POLICY_ROW: SettingsSearchEntry = {
  title: POLICY_LABEL,
  description: POLICY_DESCRIPTION,
  keywords: ['shortcut', 'terminal', 'tui', 'shell', 'policy', 'first', 'capture', 'minimize']
}

function rowEntry(def: CommandDefinition): SettingsSearchEntry {
  return {
    title: def.title,
    description: NOTES[def.id],
    keywords: ['shortcut', 'keybinding', 'hotkey', 'key', def.group, def.id]
  }
}

/** Commands whose consumers read the FIRST effective binding only, so a second chord would be
 *  dead on arrival. `speech.dictation` is the case: every dictation surface (the hold listener,
 *  the keyed gesture, the Dock mic, SpeechSection's note) goes through `dictationBinding()`, which
 *  is `effectiveBindings('speech.dictation')[0]`. Their rows get no Add and show one chip. */
const SINGLE_BINDING_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['speech.dictation'])

function groupEntry(group: CommandGroup, defs: CommandDefinition[]): SettingsSearchEntry {
  // The header must survive any query that keeps one of its rows, so its keywords are the union
  // of what those rows match on — otherwise a filtered list shows rows under the wrong heading.
  return {
    title: group,
    keywords: ['shortcut', 'keybinding', 'hotkey', ...defs.flatMap((d) => [d.title, d.id])]
  }
}

/** Does this group have anything to show under the current query? It decides BOTH the heading and
 *  the group's presence, which is why the heading is not a `SearchableRow` of its own: a row can
 *  match on its per-command note (`NOTES`) — query "tmux" hits Copy terminal selection — and a
 *  heading filtered independently would then leave that row standing under no heading at all. */
function groupVisible(query: string, group: CommandGroup, defs: CommandDefinition[]): boolean {
  if (query.trim() === '') return true
  return (
    matchesQuery(query, groupEntry(group, defs)) || defs.some((d) => matchesQuery(query, rowEntry(d)))
  )
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
  // The candidate's platform identity, computed ONCE: the reverse-shadow block and both dictation
  // gates all ask the same question of it, and three copies of one call is three chances to drift.
  const identity = bindingIdentity(combo, isMac)

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

  // REVERSE shadowing — the same collision seen from the other side, and neither gate above can
  // see it. `findMainInterceptShadowing` answers only for an INTERCEPTED id, and a bucket conflict
  // needs both commands in one bucket; binding `terminal.find` to `Cmd+W` is neither, so it passed
  // every check and produced a permanently dead shortcut with no warning — main swallows the chord
  // in `before-input-event` and the terminal surface is never offered it.
  if (!MAIN_INTERCEPTED_COMMAND_IDS.includes(id)) {
    for (const cid of MAIN_INTERCEPTED_COMMAND_IDS) {
      const hit = effectiveBindings(cid).some((b) => bindingIdentity(b, isMac) === identity)
      if (!hit) continue
      const title = COMMANDS_BY_ID.get(cid)?.title ?? cid
      const own = COMMANDS_BY_ID.get(id)?.title ?? id
      return {
        ok: false,
        error: `${chord} is intercepted app-wide for ${title}; it would never reach ${own}.`
      }
    }
  }

  // DICTATION OVERLAP, both directions. `speech.dictation` is its own conflict bucket (see
  // `conflictBucket` in @shared/keybindings), so gate (2) above is silent about it BY DESIGN —
  // dictation never competes at dispatch, it PRE-EMPTS: the resolver skips it and its own keyed
  // listener claims the chord first while the canvas has focus. That is precedence, not ambiguity,
  // which is why the LOAD path permits an overlap (legacy files contain them, and dropping a user's
  // chord is the failure that bucket closes) while a chord a user picks HERE is refused instead:
  // an interactive pick deserves to be told about the precedence, not to discover it later.
  //
  // Both gates are keyed-only WITHOUT an explicit hold guard: `bindingIdentity` renders a
  // modifier-only chord as `…:(hold)`, which no keyed identity can ever equal — so the default
  // `Cmd+Alt` hold chord blocks nothing, and a hold candidate trips nothing.
  //
  // Both are also SCOPED to `app`/`canvas`, because the gesture has a FOCUS GATE: the keyed
  // dictation listener runs only in plain app focus (`dispatchGlobalKeydown` in
  // `renderer/lib/globalKeybindings.ts` — `!ctx.typing && !ctx.terminal && !ctx.kanbanOpen`). A
  // `terminal`- or `scm`-scope command dispatches ONLY where that gate is already shut, so it
  // never competes with dictation for its chord; refusing the overlap would forbid a binding that
  // was legal before this branch and still works at dispatch (⌘⌥D on Find in terminal, say).
  const dictationId: CommandId = 'speech.dictation'
  const dictationTitle = COMMANDS_BY_ID.get(dictationId)?.title ?? dictationId
  const candidateScope = COMMANDS_BY_ID.get(id)?.scope
  if (id !== dictationId && (candidateScope === 'app' || candidateScope === 'canvas')) {
    // "rarely", not "never": dictation's keyed listener only claims the chord where it listens.
    // An app-scope command flagged `allowInTerminal` still fires in terminal focus under
    // app-first — the message must not overclaim a chord that is merely usually lost.
    const taken = effectiveBindings(dictationId).some((b) => bindingIdentity(b, isMac) === identity)
    if (taken) {
      const own = COMMANDS_BY_ID.get(id)?.title ?? id
      return {
        ok: false,
        error: `${chord} is used by ${dictationTitle}, which claims it first; it would rarely reach ${own}.`
      }
    }
  } else if (id === dictationId) {
    for (const def of COMMAND_DEFINITIONS) {
      if (def.id === dictationId) continue
      // The same focus gate, read from the other side: a focused-surface command cannot be hidden
      // by a gesture that is never offered on that surface.
      if (def.scope === 'terminal' || def.scope === 'scm') continue
      const hit = effectiveBindings(def.id).some((b) => bindingIdentity(b, isMac) === identity)
      if (!hit) continue
      return {
        ok: false,
        error: `${chord} is already used by ${def.title}; ${dictationTitle} would claim it first and hide it.`
      }
    }
  }

  setKeybindingOverride(id, nextList)
  return { ok: true }
}

/** `limit` exists for `speech.dictation`: its consumers read `dictationBinding()` — the FIRST
 *  effective binding — so showing a second chip would promise a chord that can never fire. */
function Chips({ id, limit }: { id: CommandId; limit?: number }): React.JSX.Element {
  const all = commandKeysFor(id)
  const keys = limit === undefined ? all : all.slice(0, limit)
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
  // Read through the normalizer, never as the raw field: settings.json is hand-editable, so the
  // compile-time type is not a runtime guarantee and an unknown value must render as `app-first`
  // — the same degrade `terminalShortcutPolicy()` applies at dispatch, so the pill cannot show a
  // policy the dispatcher is not using.
  const policy = normalizeTerminalShortcutPolicy(
    useSettings((s) => s.settings.terminalShortcutPolicy)
  )
  const update = useSettings((s) => s.update)
  const query = useSettingsSearch()
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
      POLICY_ROW,
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
      // The one remaining limitation is the application MENU's, not macOS's: its accelerators are
      // handled above the page on every platform. While a recorder is armed main now suspends the
      // items in `menuItemIdsToSuspend` (Minimize, Toggle Kanban Board, Settings, off-mac Close),
      // so those chords reach the recorder — but RELOAD is deliberately never suspended, because it
      // is the crash-recovery lever. See `src/main/keydown-intercept.ts`.
      // The residual clause is the KNOWN GAP `menuItemIdsToSuspend` documents: one list drives
      // both stand-downs, so the always-on app roles are deliberately left unsuspended and still
      // act while recording. The ruling stands; the user is simply told.
      description="Remap any command. Overrides are stored in settings.json under `keybindings`; Disable turns a command's shortcut off, Reset restores its default. Reload (⌘R / ⌘⇧R) cannot be recorded — it always stays with the app; the system-level chords the menu keeps — ⌘Q (Quit), ⌘H (Hide) and the developer roles — also act while recording, so don't try to bind them."
      isActive={isActive}
      searchEntries={entries}
    >
      <SearchableRow {...POLICY_ROW}>
        <div data-setting="terminal-shortcut-policy">
          <FieldRow
            label={POLICY_LABEL}
            description={POLICY_DESCRIPTION}
            control={
              <SegmentedPill<TerminalShortcutPolicy>
                value={policy}
                ariaLabel={POLICY_LABEL}
                options={[
                  { value: 'app-first', label: 'App shortcuts first' },
                  { value: 'terminal-first', label: 'Terminal first' }
                ]}
                onChange={(v) => update({ terminalShortcutPolicy: v })}
              />
            }
          />
        </div>
      </SearchableRow>

      {groups.map(([group, defs]) => {
        // A group whose header AND every row are filtered out must not render at all. The shell's
        // body is `divide-y [&>*]:py-5`, so an empty wrapper is not invisible — it draws a padded
        // strip with a divider, and a narrow query left five of those above the one real hit.
        if (!groupVisible(query, group, defs)) return null
        return (
          <Fragment key={group}>
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">
              {group}
            </h3>
            {defs.map((def) => {
              const override = overrides?.[def.id]
              const disabled = Array.isArray(override) && override.length === 0
              const single = SINGLE_BINDING_COMMANDS.has(def.id)
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
                            <Chips id={def.id} limit={single ? 1 : undefined} />
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
                          {bound && !single ? (
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
          </Fragment>
        )
      })}
    </SettingsSection>
  )
}
