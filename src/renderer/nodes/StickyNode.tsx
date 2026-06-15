import { useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'

/**
 * A sticky note node: a colored, resizable card with free-text content.
 * No PTY — purely a visual note for organizing the canvas (handy for ADHD users).
 */
export function StickyNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)
  const collapsed = !!data.collapsed

  const toggleCollapse = () =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n
        const next = !n.data.collapsed
        const expandedHeight =
          (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 200
        const height = next ? COLLAPSED_HEIGHT : expandedHeight
        return {
          ...n,
          height,
          style: { ...n.style, height },
          data: { ...n.data, collapsed: next, expandedHeight }
        }
      })
    )

  return (
    <div
      className={`sticky-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}`}
      style={{ background: `${data.color}22`, borderColor: data.color }}
    >
      <NodeResizer minWidth={160} minHeight={120} isVisible={selected && !collapsed} color={data.color} />

      <div className="sticky-node__header" style={{ background: `${data.color}33` }}>
        <button className="term-node__collapse" title={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapse}>
          {collapsed ? '▸' : '▾'}
        </button>
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
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <textarea
        className="sticky-node__body nodrag nowheel"
        value={data.text ?? ''}
        placeholder="Write a note…"
        spellCheck={false}
        onChange={(e) => updateNodeData(id, { text: e.target.value })}
      />
    </div>
  )
}
