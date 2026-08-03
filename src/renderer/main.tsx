// Bootstrap switch: under Electron the preload has already defined window.nodeTerminal
// (contextBridge runs before any renderer script), so this is a pure pass-through on
// desktop. In a browser (Server Edition) we install the WS bridge first, then boot.
async function bootstrap(): Promise<void> {
  if (!window.nodeTerminal) {
    // Record the shell BEFORE the bridge installs: affordances that only work under Electron
    // (Reveal in Finder) or only in a browser (HTTP downloads) read this. See bridge/runtime.ts.
    const [{ markBrowserRuntime }, { installWsBridge }] = await Promise.all([
      import('./bridge/runtime'),
      import('./bridge/ws-bridge')
    ])
    markBrowserRuntime()
    const connected = await installWsBridge()
    if (!connected) return // overlay is up; startReconnect reloads on the first reopen
  } else {
    // Electron desktop: main raised Chromium's WebGL context cap (--max-active-webgl-contexts),
    // so the terminal GPU-renderer budget can rise to match. A browser tab (Server Edition)
    // cannot raise its cap and stays on the default budget. On MAC desktop the budget goes the
    // other way — DOWN: the macOS compositor mishandles many live WebGL canvases (black
    // terminals after a zoom-out grant burst, whole-window flicker) with no JS-visible error,
    // so the binding limit there is the compositor, not Chromium's cap. See src/shared/webgl.ts.
    const [{ setWebglBudget }, { WEBGL_BUDGET_DESKTOP, WEBGL_BUDGET_DESKTOP_MAC }, { isMacPlatform }] =
      await Promise.all([
        import('./terminal/webgl-budget'),
        import('../shared/webgl'),
        import('../shared/platform-utils')
      ])
    setWebglBudget(isMacPlatform() ? WEBGL_BUDGET_DESKTOP_MAC : WEBGL_BUDGET_DESKTOP)
  }
  await import('./boot')
}
void bootstrap()
