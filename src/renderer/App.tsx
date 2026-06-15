import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
