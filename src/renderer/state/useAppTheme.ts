import { useSettings } from './settings'
import { resolveTerminalTheme } from '../terminal/themes'
import { resolveAppTheme, type ResolvedAppTheme } from '../lib/appTheme'

/**
 * The app's resolved appearance, live.
 *
 * Both inputs are primitives, so this re-renders only when one of them actually moves — the same
 * discipline the terminal appearance slice follows. Anything that can't read a CSS variable
 * (Monaco's theme name, React Flow props passed as JS values) reads this instead.
 */
export function useAppTheme(): ResolvedAppTheme {
  const pref = useSettings((s) => s.settings.appTheme)
  const terminalTheme = useSettings((s) => s.settings.terminalTheme)
  return resolveAppTheme(pref, resolveTerminalTheme(terminalTheme).dark)
}
