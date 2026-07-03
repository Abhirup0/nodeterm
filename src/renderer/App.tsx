import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'
import { PromptDialogHost } from './components/promptDialog'

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
      {/* In-app window.prompt replacement (Electron has no prompt); driven by promptDialog(). */}
      <PromptDialogHost />
    </ReactFlowProvider>
  )
}
