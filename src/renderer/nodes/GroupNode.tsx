import { useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_COLORS, ungroupNodes, type CanvasNode } from '../state/workspace'

/**
 * A group frame: a labeled, resizable, translucent box that contains child nodes.
 * Children are real React Flow nodes parented to this one, so dragging the frame moves
 * them together. The frame renders behind its children (it appears first in the array).
 */
export function GroupNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)

  const ungroup = () => setNodes((ns) => ungroupNodes(ns as CanvasNode[], id))

  return (
    <div className="group-node" style={{ borderColor: data.color, background: `${data.color}12` }}>
      <NodeResizer minWidth={200} minHeight={140} isVisible={selected} color={data.color} />

      <div className="group-node__header">
        <button
          className="term-node__color"
          style={{ background: data.color }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <div className="color-popover">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                onClick={() => {
                  updateNodeData(id, { color: c })
                  setShowColors(false)
                }}
              />
            ))}
          </div>
        )}
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        <button className="group-node__ungroup nodrag" title="Ungroup" onClick={ungroup}>
          ungroup
        </button>
        <button className="term-node__close" title="Remove group (keeps nodes)" onClick={ungroup}>
          ×
        </button>
      </div>
    </div>
  )
}
