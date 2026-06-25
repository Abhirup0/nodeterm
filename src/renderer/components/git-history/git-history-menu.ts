import type { MenuItem } from '../ContextMenu'
import type { GitHistoryItem } from '@shared/git-history'

export type CommitMenuHandlers = {
  openInBrowser: (item: GitHistoryItem) => void
  copyHash: (item: GitHistoryItem) => void
  copyMessage: (item: GitHistoryItem) => void
  explain: (item: GitHistoryItem) => void
  revert: (item: GitHistoryItem) => void
  branchFrom: (item: GitHistoryItem) => void
  checkout: (item: GitHistoryItem) => void
}

export function buildCommitMenuItems(item: GitHistoryItem, h: CommitMenuHandlers): MenuItem[] {
  return [
    { label: 'Open commit in browser', onClick: () => h.openInBrowser(item) },
    { label: 'Copy commit hash', onClick: () => h.copyHash(item) },
    { label: 'Copy commit message', onClick: () => h.copyMessage(item) },
    { type: 'separator' },
    { label: 'New branch from here…', onClick: () => h.branchFrom(item) },
    { label: 'Checkout this commit', onClick: () => h.checkout(item) },
    { label: 'Revert commit', onClick: () => h.revert(item), danger: true },
    { type: 'separator' },
    { label: 'Explain changes with AI', onClick: () => h.explain(item) }
  ]
}
