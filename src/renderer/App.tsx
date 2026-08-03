import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { PromptDialogHost } from './components/promptDialog'
import { SessionProvider } from './session/session'
import { localSession } from './session/localSession'
import { useSettings } from './state/settings'
import { useViewMode } from './state/viewMode'
import { setWebglEnabled } from './terminal/webgl-budget'
import { applyRendererMode } from './terminal/renderer-mode'
import { useSharedGlyph } from './canvas/SharedGlyphLayer'
import { resolveTerminalRenderer } from '../shared/webgl'
import { isMacPlatform } from '../shared/platform-utils'

export default function App() {
  // Apply the terminal-rendering setting to the two GPU coordinators, live. 'auto' resolves per
  // platform (macOS → DOM renderer: the compositor-level black/flicker failures have only ever
  // been observed there, and a public default must be the field-proven-clean configuration; WebGL
  // on a Mac is a deliberate 'on'). 'off' reclaims every context; the experimental 'shared' takes
  // the per-terminal budget down entirely and brings up the one canvas-wide glyph context
  // instead. `applyRendererMode` owns the ordering contract between the two (and its test).
  // Subscribed at the root so it holds whatever view is showing.
  const gpu = useSettings((s) => s.settings.terminalGpuRendering)
  useEffect(() => {
    applyRendererMode(resolveTerminalRenderer(gpu, isMacPlatform()), {
      setWebglEnabled,
      setSharedEnabled: (on) => useSharedGlyph.getState().setEnabled(on)
    })
  }, [gpu])

  // Keep the view-mode store's default in sync with the Settings choice, so projects the user
  // hasn't explicitly toggled follow it (and flip live when the setting changes).
  const defaultView = useSettings((s) => s.settings.defaultProjectView)
  useEffect(() => {
    useViewMode.getState().setDefaultView(defaultView === 'kanban' ? 'kanban' : 'canvas')
  }, [defaultView])

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
