import { useShallow } from 'zustand/react/shallow'
import { useSettings } from '../state/settings'
import { XTERM_VISUAL_KEYS, type XtermVisualSettings } from './terminal-config'

/**
 * The appearance slice of Settings, as ONE subscription.
 *
 * Every component that owns an xterm needs the same thirteen fields, and the alternative — one
 * `useSettings((s) => s.settings.x)` per field — was already a wall of near-identical lines that
 * had to be kept in sync across three components AND repeated in each effect's dependency array.
 * Adding an option meant touching six places, which is exactly how a surface gets left behind.
 *
 * `useShallow` is what makes this safe: selecting the settings OBJECT would re-render on every
 * unrelated settings edit (a new object identity each time), and a canvas full of live terminals
 * is the last thing that should re-render because a notification toggle moved. Shallow-comparing
 * the picked keys keeps the old behaviour — re-render only when an appearance value actually
 * changes — while collapsing the effect dependency to a single stable value.
 */
export function useXtermVisualSettings(): XtermVisualSettings {
  return useSettings(
    useShallow((s) => {
      const out = {} as Record<string, unknown>
      for (const k of XTERM_VISUAL_KEYS) out[k] = s.settings[k]
      return out as unknown as XtermVisualSettings
    })
  )
}
