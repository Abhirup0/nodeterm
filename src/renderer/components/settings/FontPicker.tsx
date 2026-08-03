import { useEffect, useMemo, useState } from 'react'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { Button } from '@renderer/ui/Button'
import {
  MONO_FONT_CATALOG,
  buildFontStack,
  createCanvasMeasurer,
  detectInstalled,
  isFontAvailable,
  primaryFamily
} from '@renderer/lib/fontDetect'

/** Marks the free-text row in the dropdown — anything not in the detected list. */
const CUSTOM = '__custom__'

/**
 * Whether this browser exposes the Local Font Access API. Chromium-only, and in the Server
 * Edition it additionally needs a secure context — so it is an ENHANCEMENT, never the mechanism:
 * the catalogue scan below works everywhere and is what the picker is actually built on.
 */
function hasLocalFontAccess(): boolean {
  return typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
}

async function queryAllFamilies(): Promise<string[]> {
  const q = (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> })
    .queryLocalFonts
  const fonts = await q()
  return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
}

/**
 * Font family picker: a list of fonts that are actually INSTALLED, plus the raw CSS stack for
 * anything the list doesn't cover.
 *
 * The free-text field alone was the whole control before, and it fails silently — type a font you
 * don't have and the terminal renders the next fallback with no indication anything went wrong.
 * So the list is filtered by real detection (`fontDetect`), and the text field grew a warning.
 */
export function FontPicker({
  value,
  onChange
}: {
  value: string
  onChange: (stack: string) => void
}): React.JSX.Element {
  // One measurer for the lifetime of the picker: it holds a single reused canvas, and building one
  // per probe is what turns a 31-font scan into a visible hitch.
  const measure = useMemo(() => createCanvasMeasurer(), [])
  const [extraFamilies, setExtraFamilies] = useState<string[]>([])
  const [browseError, setBrowseError] = useState<string | null>(null)

  // Fonts can finish loading after first paint, so re-scan once the document says it's done.
  const [fontsReady, setFontsReady] = useState(0)
  useEffect(() => {
    let alive = true
    void document.fonts?.ready.then(() => {
      if (alive) setFontsReady((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [])

  const installed = useMemo(() => {
    if (!measure) return []
    const all = [...new Set([...MONO_FONT_CATALOG, ...extraFamilies])].sort((a, b) =>
      a.localeCompare(b)
    )
    return detectInstalled(all, measure)
    // fontsReady is a re-scan trigger, not a value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, extraFamilies, fontsReady])

  const primary = primaryFamily(value)
  // `measure` being null (no canvas) means we cannot tell — and "unknown" must not render as a
  // warning that the user's font is missing.
  const missing = !!measure && !!primary && !isFontAvailable(primary, measure)
  const selectValue = installed.includes(primary) ? primary : CUSTOM

  async function browseAll(): Promise<void> {
    setBrowseError(null)
    try {
      setExtraFamilies(await queryAllFamilies())
    } catch {
      // Permission denied, or no transient activation. Not an error worth a dialog — the catalogue
      // scan and the text field both still work.
      setBrowseError('Font list unavailable — type the font name instead.')
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Select
        className="w-64"
        value={selectValue}
        aria-label="Font family"
        onChange={(e) => {
          if (e.target.value !== CUSTOM) onChange(buildFontStack(e.target.value))
        }}
      >
        {installed.length > 0 && (
          <optgroup label="Installed">
            {installed.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Other">
          <option value={CUSTOM}>Custom…</option>
        </optgroup>
      </Select>
      <Input
        className="w-64"
        value={value}
        aria-label="Font stack"
        onChange={(e) => onChange(e.target.value)}
      />
      {missing ? (
        <p className="text-[12px] leading-relaxed text-[#ff9f0a]">
          “{primary}” isn’t installed — the next font in the stack is being used.
        </p>
      ) : null}
      {hasLocalFontAccess() && !extraFamilies.length ? (
        <Button onClick={() => void browseAll()}>
          Browse all installed fonts
        </Button>
      ) : null}
      {browseError ? (
        <p className="text-[12px] leading-relaxed text-muted">{browseError}</p>
      ) : null}
    </div>
  )
}
