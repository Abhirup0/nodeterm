import { useEffect, useRef, useState } from 'react'
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
  const activity = (data.subagentActivity as string) || ''
  const body = activity || result
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Auto-scroll the live transcript to the bottom as it grows (while expanded).
  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [body, expanded])

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
    <div className={`subagent-node${working ? ' working' : ' done'}${expanded ? ' expanded' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className="subagent-node__head nodrag"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse' : 'Open output'}
        style={{ cursor: 'pointer' }}
      >
        <button
          className="subagent-node__expand"
          title={expanded ? 'Collapse' : 'Open output'}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{(data.subagentType as string) || 'subagent'}</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {data.title && !expanded && (
        <div className="subagent-node__task">{data.title as string}</div>
      )}
      {meta && <div className="subagent-node__meta">{meta}</div>}
      {expanded && (
        <div className="subagent-node__term nodrag nowheel" ref={bodyRef}>
          {data.title ? <div className="subagent-node__result-task">{data.title as string}</div> : null}
          {body || (working ? 'Working… (live output appears here)' : 'No output.')}
        </div>
      )}
    </div>
  )
}
