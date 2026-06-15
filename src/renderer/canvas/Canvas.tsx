import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Viewport
} from '@xyflow/react'
import { TerminalNode } from '../nodes/TerminalNode'
import {
  createTerminalNode,
  nodesToWorkspace,
  workspaceToNodes,
  type TermNode
} from '../state/workspace'

export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<TermNode>([])
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const { setViewport } = useReactFlow()

  const nodeTypes = useMemo(() => ({ terminal: TerminalNode }), [])

  // Load from disk on startup.
  useEffect(() => {
    let cancelled = false
    window.nodeTerminal.workspace.load().then((ws) => {
      if (cancelled) return
      setNodes(workspaceToNodes(ws))
      viewportRef.current = ws.viewport
      setViewport(ws.viewport)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [setNodes, setViewport])

  const markDirty = useCallback(() => setDirty(true), [])

  const handleNodesChange: typeof onNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes)
      // Position/size/removal changes count as unsaved (dirty) changes.
      if (changes.some((c) => c.type !== 'select')) markDirty()
    },
    [onNodesChange, markDirty]
  )

  const addTerminal = useCallback(() => {
    setNodes((ns) => [...ns, createTerminalNode(ns.length)])
    markDirty()
  }, [setNodes, markDirty])

  const save = useCallback(async () => {
    const ws = nodesToWorkspace(nodes, viewportRef.current)
    await window.nodeTerminal.workspace.save(ws)
    setDirty(false)
  }, [nodes])

  // Color/title edits are written to nodes via updateNodeData; watch the node data
  // and mark dirty when it changes so those edits are persisted too.
  useEffect(() => {
    if (ready) markDirty()
    // only when data references change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.map((n) => `${n.id}:${n.data.title}:${n.data.color}`).join('|')])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <div className="toolbar">
        <button onClick={addTerminal}>+ New terminal</button>
        <button onClick={save}>Save</button>
        <span className={`dirty-dot${dirty ? ' dirty' : ''}`} title={dirty ? 'Unsaved changes' : 'Saved'} />
        <span className="hint">Drag · pan · Ctrl/⌘+wheel to zoom</span>
      </div>

      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onMoveEnd={(_e, vp) => {
          viewportRef.current = vp
          if (ready) markDirty()
        }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionOnDrag
        panOnDrag={[1, 2]}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2c3142" />
        <Controls />
      </ReactFlow>
    </div>
  )
}
