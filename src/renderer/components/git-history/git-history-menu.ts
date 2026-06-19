import type { MenuItem } from '../ContextMenu'
import type { GitHistoryItem } from '@shared/git-history'

export type CommitMenuHandlers = {
  openInBrowser: (item: GitHistoryItem) => void
  copyHash: (item: GitHistoryItem) => void
  copyMessage: (item: GitHistoryItem) => void
  explain: (item: GitHistoryItem) => void
}

export function buildCommitMenuItems(item: GitHistoryItem, h: CommitMenuHandlers): MenuItem[] {
  return [
    { label: 'Open commit in browser', onClick: () => h.openInBrowser(item) },
    { label: 'Copy commit hash', onClick: () => h.copyHash(item) },
    { label: 'Copy commit message', onClick: () => h.copyMessage(item) },
    { type: 'separator' },
    { label: 'Explain changes with AI', onClick: () => h.explain(item) }
  ]
}
