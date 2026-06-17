import { useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * Display-only node visualizing a subagent a Claude session spawned. Shows type + task +
 * a live timer while working and duration/tokens/tool-uses when done. Click to expand and
 * read what it produced (subagents have no terminal — this is their result content).
 */
export function SubagentNode({ data }: NodeProps<CanvasNode>) {
  const working = data.subagentState !== 'done'
  const startedAt = (data.subagentStartedAt as number) || 0
  const durationMs = data.subagentDurationMs as number | undefined
  const tokens = data.subagentTokens as number | undefined
  const toolUses = data.subagentToolUses as number | undefined
  const result = (data.subagentResult as string) || ''
  const [expanded, setExpanded] = useState(false)

  // Live elapsed timer while working.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [working])

  const elapsed = working && startedAt ? fmtDur(now - startedAt) : durationMs ? fmtDur(durationMs) : ''
  const meta = [
    elapsed,
    tokens != null ? `↓ ${fmtTokens(tokens)} tokens` : null,
    toolUses ? `${toolUses} tool${toolUses === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={`subagent-node${working ? ' working' : ' done'}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className="subagent-node__head nodrag"
        onClick={() => result && setExpanded((v) => !v)}
        title={result ? (expanded ? 'Collapse' : 'Click to see what it did') : undefined}
        style={{ cursor: result ? 'pointer' : 'default' }}
      >
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{(data.subagentType as string) || 'subagent'}</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {data.title && <div className="subagent-node__task">{data.title as string}</div>}
      {meta && <div className="subagent-node__meta">{meta}</div>}
      {expanded && result && <div className="subagent-node__result nodrag nowheel">{result}</div>}
    </div>
  )
}
