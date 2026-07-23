// Bootstrap switch: under Electron the preload has already defined window.nodeTerminal
// (contextBridge runs before any renderer script), so this is a pure pass-through on
// desktop. In a browser (Server Edition) we install the WS bridge first, then boot.
async function bootstrap(): Promise<void> {
  if (!window.nodeTerminal) {
    const { installWsBridge } = await import('./bridge/ws-bridge')
    const connected = await installWsBridge()
    if (!connected) return // overlay is up; startReconnect reloads on the first reopen
  } else {
    // Electron desktop: main raised Chromium's WebGL context cap (--max-active-webgl-contexts),
    // so the terminal GPU-renderer budget can rise to match. A browser tab (Server Edition)
    // cannot raise its cap and stays on the default budget. See src/shared/webgl.ts.
    const [{ setWebglBudget }, { WEBGL_BUDGET_DESKTOP }] = await Promise.all([
      import('./terminal/webgl-budget'),
      import('../shared/webgl')
    ])
    setWebglBudget(WEBGL_BUDGET_DESKTOP)
  }
  await import('./boot')
}
void bootstrap()
