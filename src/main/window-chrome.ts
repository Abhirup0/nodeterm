import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * The window-frame options that only mean something on macOS.
 *
 * `titleBarStyle: 'hiddenInset'` + `trafficLightPosition` hide the title bar and draw the traffic
 * lights inside the web contents — that is what our tab bar's left padding is reserved for. Both
 * are macOS-only Electron options; on Windows and Linux the window keeps its native frame either
 * way, so this changes nothing there and simply stops claiming a shape those platforms don't have
 * (issue #564, where the renderer reserved the traffic-light space on Windows regardless).
 */
export function macTitleBarOptions(
  platform: NodeJS.Platform
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition'> {
  if (platform !== 'darwin') return {}
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
}
