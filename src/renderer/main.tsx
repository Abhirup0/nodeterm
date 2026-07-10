// Bootstrap switch: under Electron the preload has already defined window.nodeTerminal
// (contextBridge runs before any renderer script), so this is a pure pass-through on
// desktop. In a browser (Server Edition) we install the WS bridge first, then boot.
async function bootstrap(): Promise<void> {
  if (!window.nodeTerminal) {
    const { installWsBridge } = await import('./bridge/ws-bridge')
    await installWsBridge()
  }
  await import('./boot')
}
void bootstrap()
