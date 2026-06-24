import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesState,
  useReactFlow,
  type NodeChange
} from '@xyflow/react'
import type { CanvasMutation, CanvasNodeState } from '@shared/types'
import { TerminalNode } from '../nodes/TerminalNode'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode } from '../nodes/GroupNode'
import { EditorNode } from '../nodes/EditorNode'
import { DiffNode } from '../nodes/DiffNode'
import { withNodeBoundary } from '../components/NodeBoundary'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'

/**
 * RemoteSessionView — the CLIENT's transient mirror of a host's active-project canvas.
 *
 * It is fed by the host's pushed `canvas:state` (over `remoteClient.onCanvasState`) which it
 * renders with `nodeStatesToFlow`. Terminal nodes are bound to `RemoteTransport(connectionId)` by
 * injecting `data.remote = { connectionId }` — the host node id stays the React Flow node id, so a
 * terminal addresses the host's matching PTY/tmux session.
 *
 * The mirror is NOT persisted: nodes live only in this component's local state, never in the
 * workspace store / `flowToNodeStates` save path. The host's React Flow remains the single writer:
 * the client applies its own edits (drag-stop / delete) OPTIMISTICALLY to the local mirror and
 * sends a `CanvasMutation` to the host via `remoteClient.sendMutation`; the next authoritative
 * `canvas:state` reconciles any divergence.
 *
 * NOTE (Task 6): this component is not yet mounted anywhere. The "New Remote Connection" UX +
 * routing that swaps the main Canvas for this view (when a `connectionId` is active) is Task 6;
 * mounting is simply `<RemoteSessionView connectionId={id} onClose={...} />`.
 */
export function RemoteSessionView({
  connectionId,
  onClose
}: {
  connectionId: string
  /** Called when the user leaves the mirror; the caller disconnects the relay connection. */
  onClose: () => void
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <RemoteSessionCanvas connectionId={connectionId} onClose={onClose} />
    </ReactFlowProvider>
  )
}

// Node kinds whose `data.remote.connectionId` routes their I/O to the host over the relay:
// terminals pick RemoteTransport(connectionId); editors use remoteFs(connectionId) so they
// read/write the HOST's filesystem instead of the local one.
// NOTE: `diff` is deliberately EXCLUDED — remote git isn't proxied over the relay, so a diff node
// tagged remote would silently read the CLIENT's git/fs while appearing to mirror the host. It
// renders as an unbound (local) diff node instead, which is at least not misleading.
const REMOTE_BOUND_KINDS = new Set(['terminal', 'editor'])

/** Tag remote-capable nodes (terminal/editor) so they address the host over the relay. */
function bindRemote(states: CanvasNodeState[], connectionId: string): CanvasNode[] {
  return nodeStatesToFlow(states).map((n) =>
    n.type && REMOTE_BOUND_KINDS.has(n.type)
      ? { ...n, data: { ...n.data, remote: { connectionId } } }
      : n
  )
}

function RemoteSessionCanvas({
  connectionId,
  onClose
}: {
  connectionId: string
  onClose: () => void
}): React.JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const { fitView } = useReactFlow()
  // Fit the view once, when the host's nodes first arrive: their positions are the host's canvas
  // coordinates, which may sit far outside the mirror's default (0,0) viewport — without this the
  // mirror looks empty even though the nodes are present.
  const fittedRef = useRef(false)
  // Guard so applying an inbound host snapshot doesn't echo back as a client mutation.
  const applyingHostStateRef = useRef(false)
  // True between drag-start and drag-stop. While the user is actively dragging a node, we ignore
  // inbound host `canvas:state` snapshots so the dragged node doesn't jump back to the host's
  // last-known position mid-gesture (the drag-stop upsert + the next snapshot then reconcile).
  const draggingRef = useRef(false)

  const nodeTypes = useMemo(
    () => ({
      terminal: withNodeBoundary(TerminalNode),
      sticky: withNodeBoundary(StickyNode),
      group: withNodeBoundary(GroupNode),
      editor: withNodeBoundary(EditorNode),
      diff: withNodeBoundary(DiffNode)
    }),
    []
  )

  // Render the host's authoritative snapshot. Reconciles any local optimistic divergence.
  useEffect(() => {
    return window.nodeTerminal.remoteClient.onCanvasState(connectionId, (state) => {
      // Don't yank a node out from under an active drag — let drag-stop settle first.
      if (draggingRef.current) return
      applyingHostStateRef.current = true
      setNodes(bindRemote(state.nodes, connectionId))
      queueMicrotask(() => {
        applyingHostStateRef.current = false
      })
    })
  }, [connectionId, setNodes])

  // Bring the host's nodes into view the first time they arrive (host coords ≠ mirror viewport).
  useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return
    fittedRef.current = true
    const id = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 0 }))
    return () => cancelAnimationFrame(id)
  }, [nodes, fitView])

  // Send the client's optimistic edit upstream (the host applies it; the next snapshot reconciles).
  const sendMutation = useCallback(
    (mutation: CanvasMutation) => {
      window.nodeTerminal.remoteClient.sendMutation(connectionId, mutation)
    },
    [connectionId]
  )

  // Position changes are applied locally by React Flow; we forward the final layout on drag-stop.
  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      onNodesChange(changes)
      if (applyingHostStateRef.current) return
      // A removal is final immediately (no drag-stop), so forward it here. Drop the matching
      // remote PTY stream too — handled host-side once it sees the node gone, but the local
      // terminal already unmounts (its kill on unmount detaches the stream).
      for (const c of changes) {
        if (c.type === 'remove') sendMutation({ op: 'remove', id: c.id })
      }
    },
    [onNodesChange, sendMutation]
  )

  // On drag-stop, forward the dragged node's final state as an upsert (optimistic local apply
  // already happened via onNodesChange position updates).
  const handleNodeDragStop = useCallback(
    (_e: unknown, node: CanvasNode) => {
      draggingRef.current = false
      if (applyingHostStateRef.current) return
      // Serialize just this node back to a CanvasNodeState (reuse the shared serializer, then
      // pick the one we moved — keeps size/position/kind logic in one place).
      const state = flowToNodeStates([node]).find((n) => n.id === node.id)
      if (state) sendMutation({ op: 'upsert', node: state })
    },
    [sendMutation]
  )

  return (
    <div className="remote-session-view">
      <div className="remote-session-bar">
        <span className="remote-session-bar__dot" />
        <span className="remote-session-bar__label">Remote session</span>
        <span className="remote-session-bar__hint">mirroring the host&apos;s canvas</span>
        <button className="remote-session-bar__leave" onClick={onClose} title="Disconnect">
          Leave
        </button>
      </div>
      <div className="remote-session-flow">
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStart={() => (draggingRef.current = true)}
          onNodeDragStop={handleNodeDragStop}
          selectionMode={SelectionMode.Partial}
          panOnScroll
          zoomOnScroll={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}
