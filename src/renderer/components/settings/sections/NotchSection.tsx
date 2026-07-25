import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'

/** Keep in sync with NOTCH_WIDTH_MIN/MAX in src/main/notch-hud.ts (which clamps anyway). */
const WIDTH_MIN = 100
const WIDTH_MAX = 320

const ROWS = {
  enabled: {
    title: 'Notch HUD',
    keywords: ['notch', 'hud', 'mascot', 'menu bar', 'overlay', 'agent', 'status', 'macos', 'capsule', 'dynamic island']
  },
  width: {
    title: 'Notch width',
    keywords: ['notch', 'width', 'flush', 'align', 'capsule', 'position', 'offset', 'tune']
  },
  hover: {
    title: 'Expand on hover',
    keywords: ['notch', 'hover', 'expand', 'panel', 'click', 'open', 'sessions']
  }
}
const ENTRIES = Object.values(ROWS)

/**
 * Settings → Interface → Notch (macOS only; the page only renders it on darwin).
 *
 * Everything the notch capsule exposes lives here rather than in Appearance: the enable toggle, the
 * notch-width knob (macOS exposes no API for the real notch width, so the capsule has to assume one
 * — this is how you make it sit flush on YOUR Mac), and hover-vs-click expansion. All three apply
 * live: dragging the width slider moves the capsule as you drag.
 */
export function NotchSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notchHud = useSettings((s) => s.settings.notchHud)
  const notchWidth = useSettings((s) => s.settings.notchWidth)
  const hoverExpand = useSettings((s) => s.settings.notchHoverExpand)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="notch"
      title="Notch"
      description="Walking agent mascots inside the MacBook notch, and a mini session panel when you need it."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enabled}>
        <FieldRow
          label="Show the notch HUD"
          description="Extends the notch into a black capsule while agents work: a walking mascot per busy agent, a red dot when one needs you, a green blob when one has finished and you haven't looked yet."
          control={
            <Switch
              checked={notchHud}
              ariaLabel="macOS Notch HUD"
              onChange={(on) => update({ notchHud: on })}
            />
          }
        />
      </SearchableRow>

      <div
        className={
          'mt-3 space-y-3 border-l border-white/10 pl-4' +
          (notchHud ? '' : ' pointer-events-none opacity-40')
        }
        aria-disabled={!notchHud}
      >
        <SearchableRow {...ROWS.width}>
          <FieldRow
            label="Notch width"
            description="macOS doesn't tell apps how wide the notch is, so the capsule assumes it. Nudge this until the capsule sits flush against the notch — larger moves it left, smaller moves it right."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={WIDTH_MIN}
                  max={WIDTH_MAX}
                  step={2}
                  value={notchWidth}
                  aria-label="Assumed notch width in pixels"
                  onChange={(e) => update({ notchWidth: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-12 text-right text-[12px] text-white/50 tabular-nums">
                  {notchWidth} px
                </span>
              </div>
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.hover}>
          <FieldRow
            label="Expand on hover"
            description="Point at the capsule to open the session panel. Off = it only opens when you click it. Either way it closes when you move away — and that's when a finished session stops glowing green."
            control={
              <Switch
                checked={hoverExpand}
                ariaLabel="Expand the notch panel on hover"
                onChange={(on) => update({ notchHoverExpand: on })}
              />
            }
          />
        </SearchableRow>
      </div>
    </SettingsSection>
  )
}
