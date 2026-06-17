import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'

/**
 * Display-only node visualizing a subagent a Claude session spawned. It has no terminal
 * (subagents run inside the parent's process); it just shows the agent type, task, and
 * working/done state, with a target handle for the edge from its parent Claude node.
 */
export function SubagentNode({ data }: NodeProps<CanvasNode>) {
  const working = data.subagentState !== 'done'
  return (
    <div className={`subagent-node${working ? ' working' : ' done'}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="subagent-node__head">
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{(data.subagentType as string) || 'subagent'}</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {data.title && <div className="subagent-node__task">{data.title}</div>}
    </div>
  )
}
