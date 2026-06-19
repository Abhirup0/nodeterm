import type React from 'react'
import type { GitHistoryItem, GitHistoryItemRef } from '@shared/git-history'
import type { GitHistoryItemViewModel } from '@shared/git-history-graph'
import { dedupeRemoteTrackingRefs } from '@shared/git-history-ref-display'
import { GitHistoryGraphSvg, graphColor } from './GitHistoryGraphSvg'

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className={`scm-history__chevron${collapsed ? ' collapsed' : ''}`} viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefBadge({ itemRef }: { itemRef: GitHistoryItemRef }) {
  const color = itemRef.color ? graphColor(itemRef.color) : 'var(--border)'
  return (
    <span className="scm-history__ref" style={{ borderColor: color, color }} title={itemRef.category ? `${itemRef.name} (${itemRef.category})` : itemRef.name}>
      {itemRef.name}
    </span>
  )
}

export function GitHistoryRow({
  viewModel,
  expanded = false,
  preserveRefIds,
  onToggleExpand,
  onContextMenu
}: {
  viewModel: GitHistoryItemViewModel
  expanded?: boolean
  preserveRefIds?: readonly string[]
  onToggleExpand?: (item: GitHistoryItem) => void
  onContextMenu?: (item: GitHistoryItem, e: React.MouseEvent) => void
}) {
  const item = viewModel.historyItem
  const isBoundaryNode = viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
  const canExpand = !isBoundaryNode && Boolean(onToggleExpand)
  const refs = dedupeRemoteTrackingRefs(item.references ?? [], { preserveRefIds })
  const visibleRefs = refs.slice(0, 2)
  const hiddenRefs = refs.slice(2)
  const tooltip = item.message || item.subject

  const content = (
    <>
      <GitHistoryGraphSvg viewModel={viewModel} />
      <div className="scm-history__subject" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {canExpand && <Chevron collapsed={!expanded} />}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.subject}</span>
      </div>
      {refs.length > 0 && (
        <div className="scm-history__refs">
          {visibleRefs.map((r) => <RefBadge key={r.id} itemRef={r} />)}
          {hiddenRefs.length > 0 && (
            <span style={{ fontSize: 10, opacity: 0.6 }} title={hiddenRefs.map((r) => r.name).join(', ')}>+{hiddenRefs.length}</span>
          )}
        </div>
      )}
    </>
  )

  if (isBoundaryNode) {
    return <div className="scm-history__row" style={{ cursor: 'default', opacity: 0.7 }} title={tooltip}>{content}</div>
  }

  return (
    <button
      type="button"
      className="scm-history__row"
      title={tooltip}
      aria-expanded={canExpand ? expanded : undefined}
      onClick={() => canExpand && onToggleExpand?.(item)}
      onContextMenu={(e) => onContextMenu?.(item, e)}
    >
      {content}
    </button>
  )
}
