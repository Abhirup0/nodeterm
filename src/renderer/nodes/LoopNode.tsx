import { useEffect, useRef } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { useAgentNodes } from '../state/agentNodes'

/**
 * Loop/schedule/cron node — first-class (select/drag/resize). Shows the kind, schedule, full
 * task, and (for in-session loops) per-iteration summaries. Play re-issues the task to the
 * parent terminal (manual trigger).
 */
export function LoopNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const count = (data.loopCount as number) ?? 0
  const items = (data.loopItems as string[]) ?? []
  const active = !!data.loopActive
  const schedule = (data.loopSchedule as string) || ''
  const task = (data.loopTask as string) || ''
  const kind = (data.loopKind as string) || 'loop'
  const label = kind.charAt(0).toUpperCase() + kind.slice(1)
  const expanded = !!data.ephExpanded
  const bodyRef = useRef<HTMLDivElement>(null)
  const toggle = () => useAgentNodes.getState().toggleExpanded(id)

  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [items.length, expanded])

  const trigger = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (task) void window.nodeTerminal.pty.sendText(id.replace(/^loop-/, ''), task)
  }

  return (
    <div className={`loop-node${active ? ' working' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={180} minHeight={84} color="#bf7af0" />
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="loop-node__head nodrag" onClick={toggle} style={{ cursor: 'pointer' }}>
        <button
          className="loop-node__expand"
          title={expanded ? 'Collapse' : 'Open'}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
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
      {(task || schedule) && !expanded && <div className="loop-node__task">{task || schedule}</div>}
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
