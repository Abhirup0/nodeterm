import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'
import { Select } from '@renderer/ui/Select'
import { NumberField } from '@renderer/ui/NumberField'
import { isMacPlatform } from '@shared/platform-utils'
import type { Settings } from '@shared/types'

const ROWS = {
  fontSize: { title: 'Font size', keywords: ['font', 'size', 'text'] },
  fontFamily: { title: 'Font family', keywords: ['font', 'family', 'typeface', 'monospace'] },
  cursorBlink: { title: 'Cursor blink', keywords: ['cursor', 'blink'] },
  gpu: {
    title: 'Terminal rendering',
    keywords: [
      'gpu',
      'webgl',
      'renderer',
      'rendering',
      'flicker',
      'performance',
      'graphics',
      'acceleration',
      'shared',
      'experimental'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

export function TerminalSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="terminal" title="Terminal" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.fontSize}>
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
      </SearchableRow>
      <SearchableRow {...ROWS.fontFamily}>
        <FieldRow
          label="Font family"
          control={
            <Input
              className="w-64"
              value={settings.fontFamily}
              onChange={(e) => update({ fontFamily: e.target.value })}
            />
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
      <SearchableRow {...ROWS.gpu}>
        <FieldRow
          label="Terminal rendering"
          description={
            (isMacPlatform()
              ? 'Auto uses the DOM renderer on macOS (WebGL terminals can flicker or composite black there), so GPU per terminal is an explicit opt-in. '
              : 'Auto uses one GPU context per terminal; switch to Off if the window flickers. ') +
            'Shared GPU is experimental — every terminal paints into a single canvas-wide context, ' +
            'which lifts the per-terminal context limit but may render incorrectly; it falls back ' +
            'to DOM on failure.'
          }
          control={
            <Select
              aria-label="Terminal rendering"
              value={settings.terminalGpuRendering}
              onChange={(e) =>
                update({
                  terminalGpuRendering: e.target.value as Settings['terminalGpuRendering']
                })
              }
            >
              <option value="auto">Auto (default)</option>
              <option value="on">GPU per terminal</option>
              <option value="shared">Shared GPU (experimental)</option>
              <option value="off">Off (DOM renderer)</option>
            </Select>
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
