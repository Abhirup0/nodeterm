import { useSettings } from '../../../state/settings'
import { NODE_COLORS } from '../../../state/workspace'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import {
  HIDEABLE_HEADER_BUTTONS,
  HIDEABLE_MENU_ITEMS,
  isHidden,
  type HideableRow
} from '@renderer/lib/ui-visibility'
import { cn } from '@renderer/ui/cn'

const ROWS = {
  accent: { title: 'Accent', keywords: ['accent', 'color', 'theme', 'appearance'] },
  menuItems: {
    title: 'Node menu items',
    keywords: ['menu', 'context', 'right click', 'items', 'hide']
  },
  headerButtons: {
    title: 'Terminal header buttons',
    keywords: ['terminal', 'header', 'buttons', 'icons', 'hide']
  }
}
const ENTRIES = Object.values(ROWS)

/** Settings store what is HIDDEN, the switches say "show" — so showing drops the id and hiding
 *  appends it. Filtering first also keeps a hand-edited list free of duplicates. */
function withShown(hidden: readonly string[], id: string, shown: boolean): string[] {
  const next = hidden.filter((h) => h !== id)
  if (!shown) next.push(id)
  return next
}

/** One switch per hideable row, checked when the row is visible. */
function VisibilityToggles({
  rows,
  hidden,
  where,
  onChange
}: {
  rows: readonly HideableRow[]
  hidden: readonly string[]
  /** Completes the aria-label ("Show Duplicate in the node menu") — the label alone is ambiguous
   *  once both lists are on screen and a screen reader reads them out of context. */
  where: string
  onChange: (next: string[]) => void
}): React.JSX.Element {
  return (
    <div className="mt-3 space-y-3 border-l border-white/10 pl-4">
      {rows.map((row) => (
        <FieldRow
          key={row.id}
          label={row.label}
          control={
            <Switch
              checked={!isHidden(row.id, hidden)}
              onChange={(shown) => onChange(withShown(hidden, row.id, shown))}
              ariaLabel={`Show ${row.label} ${where}`}
            />
          }
        />
      ))}
    </div>
  )
}

export function AppearanceSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const accent = useSettings((s) => s.settings.accent)
  const hiddenNodeMenuItems = useSettings((s) => s.settings.hiddenNodeMenuItems)
  const hiddenHeaderButtons = useSettings((s) => s.settings.hiddenHeaderButtons)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.accent}>
        <div className="flex items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-text">Accent</span>
          <div className="flex flex-wrap gap-2">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${c}`}
                onClick={() => update({ accent: c })}
                style={{ background: c }}
                className={cn(
                  'size-6 rounded-full border-2',
                  accent === c ? 'border-text' : 'border-transparent'
                )}
              />
            ))}
          </div>
        </div>
      </SearchableRow>
      {/* One wrapper element per row: the section body puts a divider and its own padding around
          every direct child, so a heading + caption + list must arrive as a single node. */}
      <SearchableRow {...ROWS.menuItems}>
        <div>
          <h4 className="text-sm font-medium text-text">Node menu items</h4>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Which rows the node right-click menu offers — it applies to the next right-click.
            Destructive and recovery actions (Delete, Restart agent) are always shown.
          </p>
          <VisibilityToggles
            rows={HIDEABLE_MENU_ITEMS}
            hidden={hiddenNodeMenuItems}
            where="in the node menu"
            onChange={(next) => update({ hiddenNodeMenuItems: next })}
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.headerButtons}>
        <div>
          <h4 className="text-sm font-medium text-text">Terminal header buttons</h4>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Which icon buttons the terminal node header shows. Close and the terminal Search
            button are always shown, as are the right-click menu's destructive and recovery
            actions (Delete, Restart agent).
          </p>
          <VisibilityToggles
            rows={HIDEABLE_HEADER_BUTTONS}
            hidden={hiddenHeaderButtons}
            where="in the terminal header"
            onChange={(next) => update({ hiddenHeaderButtons: next })}
          />
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
