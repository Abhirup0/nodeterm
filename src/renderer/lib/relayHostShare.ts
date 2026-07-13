import type { Project } from '@shared/types'

/** One shareable project as shown in the host's project chooser. */
export interface HostShareOption {
  id: string
  name: string
}

/**
 * The list of projects a relay host may share, as `{id, name}[]`. Only OPEN (non-`closed`)
 * projects are shareable — a closed project isn't in the tab bar and has nothing to show a
 * joiner. The `activeProjectId` (when itself open) is hoisted to the front so it can be the
 * default selection. Pure; empty input yields an empty list.
 */
export function hostShareOptions(projects: Project[], activeProjectId: string): HostShareOption[] {
  const open = projects.filter((p) => !p.closed).map((p) => ({ id: p.id, name: p.name }))
  const activeIdx = open.findIndex((p) => p.id === activeProjectId)
  if (activeIdx <= 0) return open
  return [open[activeIdx], ...open.slice(0, activeIdx), ...open.slice(activeIdx + 1)]
}
