// The macOS-style green maximize toggle in a node's header (issue #399). One click resizes the
// NODE to fill the visible canvas — a real resize through the normal resize path, so a terminal
// reflows and gains rows (the camera never moves; canvas zoom is a CSS transform and magnifying
// an 80×24 shows no extra line). The second click restores the exact previous rect. Shared by the
// terminal, editor and diff nodes; the transforms live in state/workspace.ts so grouped nodes
// re-fit their ancestor frames in the same tick.

import { useReactFlow, useStoreApi } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { markWorkspaceDirty } from '../state/workspaceDirty'
import { maximizeNodeToRect, restoreMaximizedNode, type CanvasNode } from '../state/workspace'
import { maximizeTargetRect } from '../lib/nodeMaximize'

export function MaximizeButton({ id, maximized }: { id: string; maximized: boolean }) {
  const { setNodes, getViewport } = useReactFlow()
  const store = useStoreApi()

  const toggle = () => {
    setNodes((ns) => {
      const flow = ns as CanvasNode[]
      if (maximized) return restoreMaximizedNode(flow, id)
      const { width, height } = store.getState()
      const rect = maximizeTargetRect(getViewport(), width, height)
      return rect ? maximizeNodeToRect(flow, id, rect) : ns
    })
    // Direct setNodes bypasses handleNodesChange, so the project must be marked dirty
    // explicitly (same rule as Canvas's onApplyMutation) — else the new rect is lost on restart.
    markWorkspaceDirty()
  }

  return (
    <Tooltip
      label={maximized ? 'Restore previous size and position' : 'Maximize — fill the visible canvas'}
    >
      <button
        className="term-node__maximize nodrag"
        aria-label={maximized ? 'Restore node size' : 'Maximize node'}
        aria-pressed={maximized}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      >
        {/* macOS traffic-light arrows: outward when it will maximize, inward when it will restore. */}
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {maximized ? (
            <>
              <path d="M 5.2 1.6 L 5.2 6.8 L 0 6.8 Z" />
              <path d="M 6.8 10.4 L 6.8 5.2 L 12 5.2 Z" />
            </>
          ) : (
            <>
              <path d="M 1.6 6.8 L 1.6 1.6 L 6.8 1.6 Z" />
              <path d="M 10.4 5.2 L 10.4 10.4 L 5.2 10.4 Z" />
            </>
          )}
        </svg>
      </button>
    </Tooltip>
  )
}
