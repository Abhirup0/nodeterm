import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'

const ROWS = {
  fontSize: { title: 'Font size', keywords: ['font', 'size', 'text'] },
  fontFamily: { title: 'Font family', keywords: ['font', 'family', 'typeface', 'monospace'] },
  cursorBlink: { title: 'Cursor blink', keywords: ['cursor', 'blink'] },
  gpu: {
    title: 'GPU terminal rendering',
    keywords: ['gpu', 'webgl', 'renderer', 'flicker', 'performance', 'graphics', 'acceleration']
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
          label="GPU terminal rendering"
          description="Turn off if the window flickers. Terminals then use the DOM renderer (no WebGL)."
          control={
            <Switch
              checked={settings.terminalGpuRendering !== false}
              onChange={(v) => update({ terminalGpuRendering: v })}
              ariaLabel="GPU terminal rendering"
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
