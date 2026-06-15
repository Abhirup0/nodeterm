import { useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_COLORS, ungroupNodes, type CanvasNode } from '../state/workspace'

/**
 * A group frame: a dashed, rounded, translucent box that contains child nodes. A floating
 * label pill (color dot + name) sits on the top border; ungroup/× appear top-right on hover.
 * Children are real React Flow nodes parented to this one, so dragging the frame moves them
 * together. The frame renders behind its children (it appears first in the array).
 */
export function GroupNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)

  const ungroup = () => setNodes((ns) => ungroupNodes(ns as CanvasNode[], id))

  return (
    <div
      className={`group-node${selected ? ' selected' : ''}`}
      style={{
        borderColor: data.color,
        background: `${data.color}0f`,
        // Rounded selection ring (box-shadow follows border-radius, unlike the resizer line).
        boxShadow: selected ? `0 0 0 1.5px ${data.color}` : undefined
      }}
    >
      <NodeResizer
        minWidth={200}
        minHeight={140}
        isVisible={selected}
        color={data.color}
        lineStyle={{ borderColor: 'transparent' }}
      />

      <div className="group-node__label">
        <button
          className="group-node__dot nodrag"
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
          className="group-node__name nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
      </div>

      <div className="group-node__actions nodrag">
        <button className="group-node__ungroup" title="Ungroup" onClick={ungroup}>
          ungroup
        </button>
        <button
          className="group-node__close"
          title="Remove group (keeps nodes)"
          onClick={ungroup}
        >
          ×
        </button>
      </div>
    </div>
  )
}
