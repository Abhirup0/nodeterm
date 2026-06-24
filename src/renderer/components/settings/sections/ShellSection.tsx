import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  shell: { title: 'Default shell', keywords: ['shell', 'bash', 'zsh', 'fish', 'default'] }
}
const ENTRIES = Object.values(ROWS)

export function ShellSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const defaultShell = useSettings((s) => s.settings.defaultShell)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="shell"
      title="Shell"
      description="The shell new terminals launch. Empty uses the system default."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.shell}>
        <FieldRow
          label="Default shell"
          control={
            <Input
              className="w-64"
              placeholder="system default"
              value={defaultShell}
              onChange={(e) => update({ defaultShell: e.target.value })}
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
