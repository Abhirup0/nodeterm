import { useMemo, useState } from 'react'
import type { ProjectKanban } from '@shared/types'
import { useProjects } from '../../state/projects'
import { markWorkspaceDirty } from '../../state/workspaceDirty'
import { defaultKanban, labelsForCard } from '../../lib/kanban'
import { LabelChips } from './LabelChips'
import { LabelPicker } from './LabelPicker'

/**
 * The canvas node's label row — the SAME board labels as the kanban card (unified: a node's
 * "tags" are now board labels). Shows the colored chips and a "+" that opens the Notion picker to
 * create/assign/edit labels. Edits go to the active project's kanban and persist via the shared
 * workspace-dirty seam (this component lives outside Canvas). A node only ever renders in the
 * active project, so the active project's board is the right one.
 */
export function NodeLabels({ nodeId }: { nodeId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const kanban = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.kanban)
  // Adding the first label seeds the default board (To Do / In Progress / Done), exactly like the
  // board's own lazy default — so a node-side label add never leaves an empty column-less board.
  const board = useMemo(() => kanban ?? defaultKanban(), [kanban])
  const labels = labelsForCard(board, nodeId)

  const commit = (next: ProjectKanban): void => {
    const pid = useProjects.getState().activeProjectId
    if (!pid) return
    useProjects.getState().setProjectKanban(pid, next)
    markWorkspaceDirty()
  }

  return (
    <div className="term-node__labelrow nodrag">
      <LabelChips labels={labels} size="sm" />
      <button
        className="term-node__labeladd"
        title="Add label"
        onClick={() => setOpen((v) => !v)}
      >
        + Label
      </button>
      {open && (
        <>
          <div className="label-picker__scrim" onMouseDown={() => setOpen(false)} />
          <div className="label-picker__pop">
            <LabelPicker board={board} nodeId={nodeId} onChange={commit} />
          </div>
        </>
      )}
    </div>
  )
}
