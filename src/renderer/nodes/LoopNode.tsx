import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'

/**
 * Ephemeral node visualizing a /loop, /schedule or /cron set up on a Claude terminal.
 * Shows the kind, schedule, full task, and (for in-session loops) per-iteration summaries.
 * The Play button re-issues the task to the parent terminal (manual trigger).
 */
export function LoopNode({ id, data }: NodeProps<CanvasNode>) {
  const count = (data.loopCount as number) ?? 0
  const items = (data.loopItems as string[]) ?? []
  const active = !!data.loopActive
  const schedule = (data.loopSchedule as string) || ''
  const task = (data.loopTask as string) || ''
  const kind = (data.loopKind as string) || 'loop'
  const label = kind.charAt(0).toUpperCase() + kind.slice(1)
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [items.length, expanded])

  const trigger = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (task) void window.nodeTerminal.pty.sendText(id.replace(/^loop-/, ''), task)
  }

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
        <span className="loop-node__type">{label}</span>
        {count > 0 && <span className="loop-node__count">×{count}</span>}
        {schedule && <span className="loop-node__sched">{schedule}</span>}
        {task && (
          <button className="loop-node__play" title="Run now (manual trigger)" onClick={trigger}>
            ▶
          </button>
        )}
      </div>
      {(task || schedule) && !expanded && (
        <div className="loop-node__task">{task || schedule}</div>
      )}
      {expanded && (
        <div className="loop-node__items nodrag nowheel" ref={bodyRef}>
          {task ? <div className="loop-node__task-full">{task}</div> : null}
          {items.length
            ? items.map((it, i) => (
                <div key={i} className="loop-node__item">
                  <span className="loop-node__item-n">{i + 1}.</span> {it}
                </div>
              ))
            : !task && <span className="loop-node__empty">No activity yet.</span>}
        </div>
      )}
    </div>
  )
}
