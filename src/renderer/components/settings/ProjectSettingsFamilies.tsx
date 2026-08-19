import { useEffect, useState } from 'react'
import type {
  ProjectLocalSettings,
  ProjectSettingsDoc,
  ProjectSettingsFamily,
  ProjectSettingsSnapshot,
  ResolvedProjectSettings
} from '@shared/project-settings'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'
import { useSettingsSearch } from './context'
import { FieldRow } from './FieldRow'
import { formatEnvLines, formatListLines, parseEnvLines, parseListLines } from './project-settings-env'
import { matchesQuery, type SettingsSearchEntry } from './search'

/**
 * The four per-family editors (setup / agents / worktree / terminal) that hang off
 * `ProjectSettingsSection`: for every field, a SHARED row (writes via `saveShared`, disabled while
 * the shared file is git-conflicted) and, inside a "This machine" `<details>`, a LOCAL row for the
 * same field (writes via `saveLocal`, never disabled — a machine-local override is independent of
 * the shared file's conflict state) plus one `ignoreShared` Switch per family.
 *
 * Split out of `ProjectSettingsSection.tsx` per the Task 4 brief: four families' worth of fields
 * would have pushed that file well past ~400 lines.
 */

type FieldKind = 'input' | 'textarea' | 'switch' | 'env' | 'list'

interface FieldConfig {
  key: string
  label: string
  description?: string
  kind: FieldKind
}

interface FamilyConfig {
  title: string
  fields: FieldConfig[]
}

const FAMILY_CONFIG: Record<ProjectSettingsFamily, FamilyConfig> = {
  setup: {
    title: 'Setup',
    fields: [
      {
        key: 'setupScript',
        label: 'Setup script',
        description: 'Runs once when a worktree for this project is created.',
        kind: 'textarea'
      },
      {
        key: 'archiveScript',
        label: 'Archive script',
        description: 'Runs when a worktree for this project is archived.',
        kind: 'textarea'
      },
      {
        key: 'waitForSetup',
        label: 'Wait for setup to finish before opening a terminal',
        kind: 'switch'
      }
    ]
  },
  agents: {
    title: 'Agents',
    fields: [
      {
        key: 'defaultAgentId',
        label: 'Default agent',
        description: 'Agent id used for new sessions in this project.',
        kind: 'input'
      },
      {
        key: 'launchCmd',
        label: 'Launch command',
        description: 'Overrides how the default agent is launched.',
        kind: 'input'
      },
      {
        key: 'env',
        label: 'Environment variables',
        description: 'KEY=VALUE, one per line.',
        kind: 'env'
      }
    ]
  },
  worktree: {
    title: 'Worktree',
    fields: [
      { key: 'basePath', label: 'Base path', kind: 'input' },
      {
        key: 'baseRef',
        label: 'Base ref',
        description: 'Branch or ref new worktrees are created from.',
        kind: 'input'
      },
      {
        key: 'sharedPaths',
        label: 'Shared paths',
        description: 'One relative path per line, symlinked into every worktree.',
        kind: 'list'
      }
    ]
  },
  terminal: {
    title: 'Terminal',
    fields: [
      { key: 'shell', label: 'Shell', kind: 'input' },
      { key: 'theme', label: 'Theme', kind: 'input' },
      { key: 'fontFamily', label: 'Font family', kind: 'input' }
    ]
  }
}

const FAMILIES = Object.keys(FAMILY_CONFIG) as ProjectSettingsFamily[]

/**
 * Search metadata, derived from the config above so a field can never exist without one. Static
 * (no project name in the keywords): a query naming the PROJECT is handled one level up, by the
 * pane's `forceVisible` — see ProjectSettingsSection.
 *
 * Each family field yields ONE entry covering both of its rows (shared + "this machine"): the two
 * are the same setting, and hiding the local override while its shared twin shows would read as
 * the override having been lost.
 */
function fieldEntry(family: ProjectSettingsFamily, f: FieldConfig): SettingsSearchEntry {
  return {
    // Deliberately NOT keyworded 'project': it discriminates nothing (every entry here is a project
    // setting) while making the query "project" match every field of every project — which mounts
    // every project's pane at once, and with it an SSH settings read per project.
    title: f.label,
    description: f.description,
    keywords: [family, FAMILY_CONFIG[family].title, f.key, 'this machine', 'override']
  }
}

function ignoreSharedEntry(family: ProjectSettingsFamily): SettingsSearchEntry {
  return {
    title: `Ignore shared ${FAMILY_CONFIG[family].title.toLowerCase()} settings`,
    keywords: [family, 'ignore', 'shared', 'override', 'this machine']
  }
}

/** Every family row's search entry, for the pane's `searchEntries`. */
export const FAMILY_SEARCH_ENTRIES: SettingsSearchEntry[] = FAMILIES.flatMap((family) => [
  ...FAMILY_CONFIG[family].fields.map((f) => fieldEntry(family, f)),
  ignoreSharedEntry(family)
])

/** Text a non-env, non-list field shows in its box: the raw string, or '' when unset. */
function textOf(kind: FieldKind, raw: unknown): string {
  if (kind === 'list') return formatListLines(raw as string[] | undefined)
  return typeof raw === 'string' ? raw : ''
}

/** Text -> value for a non-env field. Blank (or all-whitespace) text clears the field. An `input`
 *  is trimmed on commit (matches the identity rows' name field); a `textarea` (script bodies)
 *  keeps its interior whitespace verbatim — only "nothing but whitespace" counts as empty. */
function valueOf(kind: FieldKind, text: string): unknown {
  if (kind === 'list') {
    const items = parseListLines(text)
    return items.length ? items : undefined
  }
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return kind === 'input' ? trimmed : text
}

function useDraft(value: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return [draft, setDraft]
}

function textareaClass(disabled?: boolean): string {
  return `min-h-20 w-72 rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-text outline-none focus:border-accent${disabled ? ' disabled:opacity-50' : ''}`
}

function StringField({
  id,
  label,
  ariaLabel,
  description,
  note,
  multiline,
  text,
  disabled,
  onCommit
}: {
  id: string
  label: string
  /** Accessible name, when it must differ from the visible label — a LOCAL row carries
   *  "(this machine)" so it does not present the same name as its shared twin (SwitchField's
   *  `ariaLabel` does the same). Omitted on a shared row, which is named by its `<label>`. */
  ariaLabel?: string
  description?: string
  note?: string
  multiline: boolean
  text: string
  disabled?: boolean
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useDraft(text)
  const commit = (): void => {
    if (draft !== text) onCommit(draft)
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      htmlFor={id}
      control={
        multiline ? (
          <textarea
            id={id}
            value={draft}
            aria-label={ariaLabel}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            className={textareaClass(disabled)}
          />
        ) : (
          <Input
            id={id}
            className="w-72"
            value={draft}
            aria-label={ariaLabel}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        )
      }
    />
  )
}

/** `env` gets its own field: unlike every other field, its warn note is a LIVE parse of the
 *  current draft (rejected lines only exist before a commit — once saved, only the valid pairs
 *  remain, so there is nothing left to report). Provenance note is shown once the draft has
 *  nothing to reject. */
function EnvField({
  id,
  label,
  ariaLabel,
  description,
  disabled,
  text,
  overrideNote,
  onCommitValue
}: {
  id: string
  label: string
  /** See `StringField`'s `ariaLabel`: the local row's name carries "(this machine)". */
  ariaLabel?: string
  description?: string
  disabled?: boolean
  text: string
  overrideNote?: string
  onCommitValue: (value: Record<string, string> | undefined) => void
}): React.JSX.Element {
  const [draft, setDraft] = useDraft(text)
  const { rejected } = parseEnvLines(draft)
  const note = rejected.length > 0 ? `Ignored (not KEY=VALUE): ${rejected.join(', ')}` : overrideNote
  const commit = (): void => {
    if (draft === text) return
    const { env } = parseEnvLines(draft)
    onCommitValue(Object.keys(env).length ? env : undefined)
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      htmlFor={id}
      control={
        <textarea
          id={id}
          value={draft}
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className={textareaClass(disabled)}
        />
      }
    />
  )
}

function SwitchField({
  label,
  description,
  note,
  ariaLabel,
  checked,
  disabled,
  onCommit
}: {
  label: string
  description?: string
  note?: string
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  onCommit: (v: boolean) => void
}): React.JSX.Element {
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      control={
        <Switch checked={checked} ariaLabel={ariaLabel} disabled={disabled} onChange={onCommit} />
      }
    />
  )
}

/** Merges one family field into the WHOLE local settings object, preserving every other family and
 *  `ignoreShared` untouched — `saveLocal` replaces the file, so dropping a sibling here would erase
 *  it from disk. `undefined` clears the field; an emptied family key is dropped, and an entirely
 *  empty result collapses to `undefined` (clears the local overlay file itself). */
function nextLocalField(
  current: ProjectLocalSettings | undefined,
  family: ProjectSettingsFamily,
  key: string,
  value: unknown
): ProjectLocalSettings | undefined {
  const out: Record<string, unknown> = { ...current }
  const familyObj: Record<string, unknown> = {
    ...((current?.[family] as Record<string, unknown> | undefined) ?? {})
  }
  if (value === undefined) delete familyObj[key]
  else familyObj[key] = value
  if (Object.keys(familyObj).length === 0) delete out[family]
  else out[family] = familyObj
  return Object.keys(out).length === 0 ? undefined : (out as ProjectLocalSettings)
}

function nextLocalIgnoreShared(
  current: ProjectLocalSettings | undefined,
  family: ProjectSettingsFamily,
  on: boolean
): ProjectLocalSettings | undefined {
  const out: Record<string, unknown> = { ...current }
  const ignore: Record<string, unknown> = { ...(current?.ignoreShared ?? {}) }
  if (on) ignore[family] = true
  else delete ignore[family]
  if (Object.keys(ignore).length === 0) delete out.ignoreShared
  else out.ignoreShared = ignore
  return Object.keys(out).length === 0 ? undefined : (out as ProjectLocalSettings)
}

/** What a refused write says. Shared and local fail for different reasons and are recoverable in
 *  different ways, so they do not share one vague sentence. */
const SAVE_FAILED_NOTE: Record<'shared' | 'local', string> = {
  shared:
    'Could not save — the shared settings file may be conflicted or unavailable; reload the project settings.',
  local: 'Could not save this override on this machine; reload the project settings.'
}

function FamilySection({
  projectId,
  family,
  sharedFamily,
  localFamily,
  ignoreShared,
  resolvedFamily,
  conflict,
  ready,
  sharedEditable,
  saveShared,
  saveLocal,
  reload
}: {
  projectId: string
  family: ProjectSettingsFamily
  sharedFamily: Record<string, unknown> | undefined
  localFamily: Record<string, unknown> | undefined
  ignoreShared: boolean
  resolvedFamily: Record<string, { source: 'local' | 'shared' } | undefined>
  conflict: boolean
  /** False until `snapshot` is an actual object (not `'loading'`, not `null`). Gates EVERY editor
   *  in this family, shared and local alike: before the first read answers (or after a failed
   *  one), there is no reliable doc to merge an edit into, and for an SSH project that window is a
   *  network round-trip, not a render tick — a blur landing in it would write a doc built from
   *  `{}`/`undefined`, silently deleting every other family already on disk. */
  ready: boolean
  /** False when this project has no file to share (see `ProjectFamilyEditors`). */
  sharedEditable: boolean
  saveShared: (doc: ProjectSettingsDoc) => Promise<boolean>
  saveLocal: (
    update: (current: ProjectLocalSettings | undefined) => ProjectLocalSettings | undefined
  ) => Promise<boolean>
  /** Re-reads the project's settings. Rung after a REFUSED shared write: a refusal is usually the
   *  file's answer, not ours (it went conflicted, or the folder went away, between our read and our
   *  write), and only a fresh read can make the pane describe the file as it now is. */
  reload: () => void
}): React.JSX.Element | null {
  const config = FAMILY_CONFIG[family]
  const sharedDisabled = conflict || !ready || !sharedEditable
  const localDisabled = !ready
  // Which half last refused a write, or null. Set from the saver's own answer — before this, a
  // `false` was dropped on the floor and the row simply snapped back to its old value, which reads
  // as "the app ignored me". Cleared by the next save of the same half that succeeds; NOT cleared
  // by the reload a failure triggers (that would erase the message we just put up).
  const [saveFailed, setSaveFailed] = useState<'shared' | 'local' | null>(null)
  // Row-level search filtering. Done here rather than with `SearchableRow` wrappers because every
  // field renders TWICE (shared + "this machine") from the same list — filtering the list keeps
  // the two copies in step by construction. An entirely unmatched family drops out, heading and
  // "This machine" disclosure included, so the search never leaves an empty shell behind.
  const query = useSettingsSearch()
  const fields = config.fields.filter((f) => matchesQuery(query, fieldEntry(family, f)))
  const showIgnoreShared = matchesQuery(query, ignoreSharedEntry(family))
  if (fields.length === 0 && !showIgnoreShared) return null

  // Guarded here too, not just via the `disabled` attribute below: a disabled control blocks real
  // user interaction, but nothing stops a caller (or a test) from dispatching events on it
  // directly, and the merge-base hazard this guards against is a data-corruption risk, not a UX
  // nicety — it must hold even if the DOM attribute is bypassed.
  // Every commit path routes its saver's answer through here: a dropped `false` is a silent data
  // loss — the row reverts to the stored value with no explanation, which is indistinguishable
  // from the app ignoring the edit.
  const settle = (half: 'shared' | 'local', ok: boolean): void => {
    if (ok) {
      setSaveFailed((prev) => (prev === half ? null : prev))
      return
    }
    setSaveFailed(half)
    if (half === 'shared') reload()
  }
  const commitShared = (key: string, value: unknown): void => {
    if (sharedDisabled) return
    void saveShared({ [family]: { [key]: value } } as ProjectSettingsDoc).then((ok) =>
      settle('shared', ok)
    )
  }
  const commitLocal = (key: string, value: unknown): void => {
    if (localDisabled) return
    void saveLocal((current) => nextLocalField(current, family, key, value)).then((ok) =>
      settle('local', ok)
    )
  }
  const commitIgnoreShared = (on: boolean): void => {
    if (localDisabled) return
    void saveLocal((current) => nextLocalIgnoreShared(current, family, on)).then((ok) =>
      settle('local', ok)
    )
  }

  const renderShared = (f: FieldConfig): React.JSX.Element => {
    const overridden = resolvedFamily[f.key]?.source === 'local'
    const id = `project-${family}-${f.key}-${projectId}`
    const overrideNote = overridden ? 'Overridden on this machine' : undefined
    if (f.kind === 'switch') {
      return (
        <SwitchField
          key={f.key}
          label={f.label}
          description={f.description}
          note={overrideNote}
          ariaLabel={f.label}
          checked={sharedFamily?.[f.key] === true}
          disabled={sharedDisabled}
          onCommit={(on) => commitShared(f.key, on ? true : undefined)}
        />
      )
    }
    if (f.kind === 'env') {
      return (
        <EnvField
          key={f.key}
          id={id}
          label={f.label}
          description={f.description}
          disabled={sharedDisabled}
          text={formatEnvLines(sharedFamily?.[f.key] as Record<string, string> | undefined)}
          overrideNote={overrideNote}
          onCommitValue={(v) => commitShared(f.key, v)}
        />
      )
    }
    return (
      <StringField
        key={f.key}
        id={id}
        label={f.label}
        description={f.description}
        multiline={f.kind === 'textarea' || f.kind === 'list'}
        note={overrideNote}
        disabled={sharedDisabled}
        text={textOf(f.kind, sharedFamily?.[f.key])}
        onCommit={(text) => commitShared(f.key, valueOf(f.kind, text))}
      />
    )
  }

  const renderLocal = (f: FieldConfig): React.JSX.Element => {
    const active = resolvedFamily[f.key]?.source === 'local'
    const id = `project-${family}-${f.key}-local-${projectId}`
    const activeNote = active ? 'Active' : undefined
    if (f.kind === 'switch') {
      return (
        <SwitchField
          key={f.key}
          label={f.label}
          description={f.description}
          note={activeNote}
          ariaLabel={`${f.label} (this machine)`}
          checked={localFamily?.[f.key] === true}
          disabled={localDisabled}
          onCommit={(on) => commitLocal(f.key, on ? true : undefined)}
        />
      )
    }
    if (f.kind === 'env') {
      return (
        <EnvField
          key={f.key}
          id={id}
          label={f.label}
          description={f.description}
          ariaLabel={`${f.label} (this machine)`}
          disabled={localDisabled}
          text={formatEnvLines(localFamily?.[f.key] as Record<string, string> | undefined)}
          overrideNote={activeNote}
          onCommitValue={(v) => commitLocal(f.key, v)}
        />
      )
    }
    return (
      <StringField
        key={f.key}
        id={id}
        label={f.label}
        ariaLabel={`${f.label} (this machine)`}
        description={f.description}
        multiline={f.kind === 'textarea' || f.kind === 'list'}
        note={activeNote}
        disabled={localDisabled}
        text={textOf(f.kind, localFamily?.[f.key])}
        onCommit={(text) => commitLocal(f.key, valueOf(f.kind, text))}
      />
    )
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-[13px] font-semibold text-text">{config.title}</h3>
      {saveFailed ? (
        <p role="status" className="text-[12px] leading-relaxed text-[color:var(--warn)]">
          {SAVE_FAILED_NOTE[saveFailed]}
        </p>
      ) : null}
      <div className="space-y-2.5">{fields.map(renderShared)}</div>
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">This machine</summary>
        <div className="mt-3 space-y-2.5">
          <p className="text-[12px] leading-relaxed text-muted">
            Overrides that apply only on this machine. Never written to the shared file.
          </p>
          {fields.map(renderLocal)}
          {showIgnoreShared && (
            <SwitchField
              label={`Ignore shared ${config.title.toLowerCase()} settings`}
              description="Never use the git-shared values for this family on this machine, even where this machine sets none of its own."
              ariaLabel={`Ignore shared ${family} settings on this machine`}
              checked={ignoreShared}
              disabled={localDisabled}
              onCommit={commitIgnoreShared}
            />
          )}
        </div>
      </details>
    </div>
  )
}

export function ProjectFamilyEditors({
  projectId,
  snapshot,
  resolved,
  conflict,
  sharedEditable,
  saveShared,
  saveLocal,
  reload
}: {
  projectId: string
  snapshot: ProjectSettingsSnapshot | null | 'loading'
  resolved: ResolvedProjectSettings
  conflict: boolean
  /**
   * False for a project with no folder at all — an inline canvas tab (no `cwd`, no `ssh`). There is
   * nowhere to put a `.nodeterm/settings.json`, so the store refuses every shared write
   * (`writeProjectSettings` returns false on `!e.cwd`); rendering live editors there offers a save
   * that can only ever fail. The shared rows go read-only with a sentence saying why.
   *
   * The "This machine" rows stay live: the local overlay lives in this machine's workspace index,
   * not in the project folder, so `updateLocal` genuinely succeeds for a folderless project.
   */
  sharedEditable: boolean
  saveShared: (doc: ProjectSettingsDoc) => Promise<boolean>
  saveLocal: (
    update: (current: ProjectLocalSettings | undefined) => ProjectLocalSettings | undefined
  ) => Promise<boolean>
  reload: () => void
}): React.JSX.Element {
  // Loading and failed-read (`null`) both mean "no doc it is safe to merge an edit into" — see
  // `FamilySection`'s `ready` doc comment.
  const ready = snapshot !== 'loading' && snapshot !== null
  const shared: ProjectSettingsDoc = snapshot && snapshot !== 'loading' && snapshot.shared ? snapshot.shared : {}
  const local: ProjectLocalSettings | undefined = snapshot && snapshot !== 'loading' ? snapshot.local : undefined
  return (
    <>
      {!sharedEditable ? (
        <p className="border-t border-border pt-4 text-[13px] leading-relaxed text-muted">
          This project has no folder, so there is no shared <code>.nodeterm/settings.json</code> to
          write: the shared rows below are read-only. Overrides under &ldquo;This machine&rdquo;
          still apply.
        </p>
      ) : null}
      {FAMILIES.map((family) => (
        <FamilySection
          key={family}
          projectId={projectId}
          family={family}
          sharedFamily={shared[family] as Record<string, unknown> | undefined}
          localFamily={local?.[family] as Record<string, unknown> | undefined}
          ignoreShared={local?.ignoreShared?.[family] === true}
          resolvedFamily={resolved[family] as Record<string, { source: 'local' | 'shared' } | undefined>}
          conflict={conflict}
          ready={ready}
          sharedEditable={sharedEditable}
          saveShared={saveShared}
          saveLocal={saveLocal}
          reload={reload}
        />
      ))}
    </>
  )
}
