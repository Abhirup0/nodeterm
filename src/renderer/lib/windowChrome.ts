/**
 * Where the window's own controls are drawn — the one fact the tab bar's left padding depends on.
 *
 * The tab bar reserves space on the LEFT only because macOS draws the traffic lights INSIDE the
 * web contents when Electron's `titleBarStyle: 'hiddenInset'` is used (`createWindow` sets it on
 * darwin only). Nowhere else are they there: Windows and Linux keep a native frame with the
 * controls in their own title bar, and a Server Edition browser tab has no window controls of its
 * own at all. Reserving the space anyway pushed the logo ~86px in and took the same 86px off the
 * tab strip — see issue #564.
 *
 * Both inputs are parameters so the decision can be tested; the defaults read the live values.
 */
import { isMacPlatform } from '@shared/platform-utils'
import { isBrowserRuntime } from '../bridge/runtime'

/** True only where the macOS traffic lights sit inside our own tab bar. */
export function hasInsetTrafficLights(
  mac: boolean = isMacPlatform(),
  browser: boolean = isBrowserRuntime()
): boolean {
  return mac && !browser
}

/**
 * Stamp the fact on the document root so CSS can scope the reservation
 * (`:root[data-window-chrome='inset'] .tabbar`). Absent = no reservation, which is the
 * safe default: a missing attribute costs 86px of tab width, a wrong one costs a covered logo.
 */
export function applyWindowChrome(
  root: HTMLElement = document.documentElement,
  inset: boolean = hasInsetTrafficLights()
): void {
  if (inset) root.dataset.windowChrome = 'inset'
  else delete root.dataset.windowChrome
}
