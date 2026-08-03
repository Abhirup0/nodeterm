import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { TerminalPreview } from '../TerminalPreview'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'
import { Select } from '@renderer/ui/Select'
import { NumberField } from '@renderer/ui/NumberField'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { TERMINAL_THEMES, resolveTerminalTheme } from '@renderer/terminal/themes'
import {
  TERMINAL_LETTER_SPACING_MAX,
  TERMINAL_LETTER_SPACING_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN
} from '@renderer/terminal/terminal-config'
import { resolveGpuRendering } from '@shared/webgl'
import { isMacPlatform } from '@shared/platform-utils'
import type { TerminalCursorInactiveStyle, TerminalCursorStyle } from '@shared/types'

// One entry per row. The keywords matter as much as the titles: settings search matches on them,
// and an appearance setting is far more often looked for by symptom ("colors", "scheme",
// "spacing") than by whatever we chose to call it.
const ROWS = {
  fontSize: { title: 'Font size', keywords: ['font', 'size', 'text', 'zoom'] },
  fontFamily: {
    title: 'Font family',
    keywords: ['font', 'family', 'typeface', 'monospace', 'mono']
  },
  theme: {
    title: 'Colour theme',
    keywords: [
      'theme',
      'color',
      'colour',
      'scheme',
      'palette',
      'ansi',
      'dracula',
      'nord',
      'gruvbox',
      'solarized',
      'tokyo',
      'catppuccin',
      'dark',
      'light'
    ]
  },
  cursorStyle: {
    title: 'Cursor style',
    keywords: ['cursor', 'style', 'block', 'bar', 'beam', 'underline']
  },
  cursorInactive: {
    title: 'Cursor when unfocused',
    keywords: ['cursor', 'inactive', 'unfocused', 'blurred', 'outline']
  },
  cursorBlink: { title: 'Cursor blink', keywords: ['cursor', 'blink'] },
  lineHeight: {
    title: 'Line height',
    keywords: ['line', 'height', 'leading', 'spacing', 'density']
  },
  letterSpacing: {
    title: 'Letter spacing',
    keywords: ['letter', 'spacing', 'tracking', 'character', 'width']
  },
  gpu: {
    title: 'GPU terminal rendering',
    keywords: ['gpu', 'webgl', 'renderer', 'flicker', 'performance', 'graphics', 'acceleration']
  }
}
const ENTRIES = Object.values(ROWS)

const CURSOR_STYLES: { value: TerminalCursorStyle; label: string }[] = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' }
]

const CURSOR_INACTIVE_STYLES: { value: TerminalCursorInactiveStyle; label: string }[] = [
  { value: 'outline', label: 'Outline' },
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' },
  { value: 'none', label: 'Hidden' }
]

/** A sub-heading inside the section. Terminal grew past the point where one flat list of rows
 *  reads as anything — the groups are what keep it scannable. */
function GroupHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{children}</h4>
  )
}

/** The theme's background plus a few of its colours, so the picker is legible without reading
 *  every option's name. */
function ThemeSwatch({ themeId }: { themeId: string }): React.JSX.Element {
  const { theme } = resolveTerminalTheme(themeId)
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-1"
      style={{ background: theme.background }}
      aria-hidden="true"
    >
      {[theme.foreground, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta].map(
        (c, i) => (
          <span key={i} className="size-2 rounded-full" style={{ background: c }} />
        )
      )}
    </span>
  )
}

export function TerminalSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const darkThemes = TERMINAL_THEMES.filter((t) => t.dark)
  const lightThemes = TERMINAL_THEMES.filter((t) => !t.dark)
  return (
    <SettingsSection id="terminal" title="Terminal" isActive={isActive} searchEntries={ENTRIES}>
      {/* The group headings ride on the FIRST row of each group rather than standing alone, so a
          search that hides every row in a group takes its heading with it. */}
      <SearchableRow {...ROWS.fontSize}>
        <div className="space-y-3">
          <GroupHeading>Font</GroupHeading>
          <FieldRow
            label="Font size"
            control={
              <NumberField
                value={settings.fontSize}
                min={8}
                max={28}
                onChange={(v) => update({ fontSize: v || 13 })}
              />
            }
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.fontFamily}>
        <FieldRow
          label="Font family"
          description="A CSS font stack. Names that aren't installed are skipped, so keep a generic monospace last."
          control={
            <Input
              className="w-64"
              value={settings.fontFamily}
              onChange={(e) => update({ fontFamily: e.target.value })}
            />
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.theme}>
        <div className="space-y-3">
          <GroupHeading>Colours</GroupHeading>
          <FieldRow
            label="Colour theme"
            description="Applies to every terminal — on the canvas and in kanban cards."
            control={
              <span className="flex items-center gap-2">
                <ThemeSwatch themeId={settings.terminalTheme} />
                {/* Value goes through the resolver so a stored id we no longer ship shows the
                    default as selected, instead of leaving the picker apparently blank. */}
                <Select
                  className="w-48"
                  value={resolveTerminalTheme(settings.terminalTheme).id}
                  onChange={(e) => update({ terminalTheme: e.target.value })}
                  aria-label="Colour theme"
                >
                  <optgroup label="Dark">
                    {darkThemes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Light">
                    {lightThemes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                </Select>
              </span>
            }
          />
          <TerminalPreview />
        </div>
      </SearchableRow>

      <SearchableRow {...ROWS.cursorStyle}>
        <div className="space-y-3">
          <GroupHeading>Cursor</GroupHeading>
          <FieldRow
            label="Cursor style"
            control={
              <SegmentedPill
                value={settings.cursorStyle}
                options={CURSOR_STYLES}
                onChange={(v) => update({ cursorStyle: v })}
                ariaLabel="Cursor style"
              />
            }
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.cursorInactive}>
        <FieldRow
          label="Cursor when unfocused"
          description="What the cursor looks like in a terminal that isn't taking your keystrokes — the quickest way to tell which of a canvas full of terminals is focused."
          control={
            <Select
              className="w-36"
              value={settings.cursorInactiveStyle}
              onChange={(e) =>
                update({ cursorInactiveStyle: e.target.value as TerminalCursorInactiveStyle })
              }
              aria-label="Cursor when unfocused"
            >
              {CURSOR_INACTIVE_STYLES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.cursorBlink}>
        <FieldRow
          label="Cursor blink"
          control={
            <Switch
              checked={settings.cursorBlink}
              onChange={(v) => update({ cursorBlink: v })}
              ariaLabel="Cursor blink"
            />
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.lineHeight}>
        <div className="space-y-3">
          <GroupHeading>Spacing</GroupHeading>
          <FieldRow
            label="Line height"
            description="A multiple of the font size. Higher is airier but fits fewer rows."
            control={
              <NumberField
                value={settings.terminalLineHeight}
                min={TERMINAL_LINE_HEIGHT_MIN}
                max={TERMINAL_LINE_HEIGHT_MAX}
                step={0.05}
                onChange={(v) => update({ terminalLineHeight: v || 1 })}
              />
            }
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.letterSpacing}>
        <FieldRow
          label="Letter spacing"
          description="Extra pixels between characters. Past a point the box-drawing characters agent CLIs frame their output with stop meeting."
          control={
            <NumberField
              value={settings.terminalLetterSpacing}
              min={TERMINAL_LETTER_SPACING_MIN}
              max={TERMINAL_LETTER_SPACING_MAX}
              step={0.5}
              onChange={(v) => update({ terminalLetterSpacing: v ?? 0 })}
            />
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.gpu}>
        <div className="space-y-3">
          <GroupHeading>Advanced</GroupHeading>
          <FieldRow
            label="GPU terminal rendering"
            description={
              isMacPlatform()
                ? 'Off by default on macOS (WebGL terminals can flicker or composite black there). Turning it on is an explicit opt-in.'
                : 'Turn off if the window flickers. Terminals then use the DOM renderer (no WebGL).'
            }
            control={
              <Switch
                checked={resolveGpuRendering(settings.terminalGpuRendering, isMacPlatform())}
                onChange={(v) => update({ terminalGpuRendering: v ? 'on' : 'off' })}
                ariaLabel="GPU terminal rendering"
              />
            }
          />
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
