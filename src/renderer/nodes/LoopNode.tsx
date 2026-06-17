import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'

/**
 * Ephemeral node visualizing a /loop running on a Claude terminal: iteration count and a
 * per-iteration summary list. Click to expand. Connected by an edge to its parent node.
 */
export function LoopNode({ data }: NodeProps<CanvasNode>) {
  const count = (data.loopCount as number) ?? 0
  const items = (data.loopItems as string[]) ?? []
  const active = !!data.loopActive
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [items.length, expanded])

  return (
    <div className={`loop-node${active ? ' working' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className="loop-node__head nodrag"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse' : 'Click to expand'}
        style={{ cursor: 'pointer' }}
      >
        <span className="loop-node__dot" />
        <span className="loop-node__type">Loop</span>
        <span className="loop-node__count">×{count}</span>
      </div>
      {data.title && !expanded && <div className="loop-node__task">{data.title as string}</div>}
      {expanded && (
        <div className="loop-node__items nodrag nowheel" ref={bodyRef}>
          {data.title ? <div className="loop-node__task-full">{data.title as string}</div> : null}
          {items.length ? (
            items.map((it, i) => (
              <div key={i} className="loop-node__item">
                <span className="loop-node__item-n">{i + 1}.</span> {it}
              </div>
            ))
          ) : (
            <span className="loop-node__empty">No iterations yet.</span>
          )}
        </div>
      )}
    </div>
  )
}
