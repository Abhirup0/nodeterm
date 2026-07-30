import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { PromptDialogHost } from './components/promptDialog'
import { SessionProvider } from './session/session'
import { localSession } from './session/localSession'
import { useSettings } from './state/settings'
import { setWebglEnabled } from './terminal/webgl-budget'

export default function App() {
  // Apply the GPU-terminal-rendering toggle to the WebGL budget coordinator, live. Off reclaims
  // every context (terminals fall back to the DOM renderer) — the escape hatch for the macOS
  // compositor-flicker case. Subscribed at the root so it holds whatever view is showing.
  const gpu = useSettings((s) => s.settings.terminalGpuRendering)
  useEffect(() => {
    setWebglEnabled(gpu !== false)
  }, [gpu])

  return (
    <SessionProvider session={localSession}>
      <ReactFlowProvider>
        <Canvas />
        {/* In-app window.prompt replacement (Electron has no prompt); driven by promptDialog(). */}
        <PromptDialogHost />
      </ReactFlowProvider>
    </SessionProvider>
  )
}
