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
import { FieldRow } from './FieldRow'
import { formatEnvLines, formatListLines, parseEnvLines, parseListLines } from './project-settings-env'

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
  description,
  note,
  multiline,
  text,
  disabled,
  onCommit
}: {
  id: string
  label: string
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
  description,
  disabled,
  text,
  overrideNote,
  onCommitValue
}: {
  id: string
  label: string
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

function FamilySection({
  projectId,
  family,
  sharedFamily,
  localFamily,
  ignoreShared,
  resolvedFamily,
  conflict,
  fullLocal,
  saveShared,
  saveLocal
}: {
  projectId: string
  family: ProjectSettingsFamily
  sharedFamily: Record<string, unknown> | undefined
  localFamily: Record<string, unknown> | undefined
  ignoreShared: boolean
  resolvedFamily: Record<string, { source: 'local' | 'shared' } | undefined>
  conflict: boolean
  fullLocal: ProjectLocalSettings | undefined
  saveShared: (doc: ProjectSettingsDoc) => Promise<boolean>
  saveLocal: (local: ProjectLocalSettings | undefined) => Promise<boolean>
}): React.JSX.Element {
  const config = FAMILY_CONFIG[family]

  const commitShared = (key: string, value: unknown): void => {
    void saveShared({ [family]: { [key]: value } } as ProjectSettingsDoc)
  }
  const commitLocal = (key: string, value: unknown): void => {
    void saveLocal(nextLocalField(fullLocal, family, key, value))
  }
  const commitIgnoreShared = (on: boolean): void => {
    void saveLocal(nextLocalIgnoreShared(fullLocal, family, on))
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
          disabled={conflict}
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
          disabled={conflict}
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
        disabled={conflict}
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
        description={f.description}
        multiline={f.kind === 'textarea' || f.kind === 'list'}
        note={activeNote}
        text={textOf(f.kind, localFamily?.[f.key])}
        onCommit={(text) => commitLocal(f.key, valueOf(f.kind, text))}
      />
    )
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-[13px] font-semibold text-text">{config.title}</h3>
      <div className="space-y-2.5">{config.fields.map(renderShared)}</div>
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">This machine</summary>
        <div className="mt-3 space-y-2.5">
          <p className="text-[12px] leading-relaxed text-muted">
            Overrides that apply only on this machine. Never written to the shared file.
          </p>
          {config.fields.map(renderLocal)}
          <SwitchField
            label={`Ignore shared ${config.title.toLowerCase()} settings`}
            description="Never use the git-shared values for this family on this machine, even where this machine sets none of its own."
            ariaLabel={`Ignore shared ${family} settings on this machine`}
            checked={ignoreShared}
            onCommit={commitIgnoreShared}
          />
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
  saveShared,
  saveLocal
}: {
  projectId: string
  snapshot: ProjectSettingsSnapshot | null | 'loading'
  resolved: ResolvedProjectSettings
  conflict: boolean
  saveShared: (doc: ProjectSettingsDoc) => Promise<boolean>
  saveLocal: (local: ProjectLocalSettings | undefined) => Promise<boolean>
}): React.JSX.Element {
  const shared: ProjectSettingsDoc = snapshot && snapshot !== 'loading' && snapshot.shared ? snapshot.shared : {}
  const local: ProjectLocalSettings | undefined = snapshot && snapshot !== 'loading' ? snapshot.local : undefined
  return (
    <>
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
          fullLocal={local}
          saveShared={saveShared}
          saveLocal={saveLocal}
        />
      ))}
    </>
  )
}
