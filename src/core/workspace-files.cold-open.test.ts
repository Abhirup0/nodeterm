import { describe, it, expect } from 'vitest'
import { projectToFile, fileToProject, serializeProjectFile } from './workspace-files'
import type { CanvasNodeState, PendingLaunch, Project } from '../shared/types'

/**
 * Issue #338 Task 2.0, pin (c) — the DISK half of the cold-open round-trip. A `--project`-targeted
 * open writes its node into the target project's serialized store with the launch command in
 * `pendingLaunch: { after: [], command }`, then `writeDisk` persists it. The target project may
 * not be viewed until after an app restart, when only the file's copy exists — so the armed
 * launch has to survive `projectToFile → serialize → parse → fileToProject` or the node would
 * silently never start. The live↔store pins (a)/(b) live in
 * `src/renderer/state/workspace.cold-open.test.ts`.
 */
describe('cold-open pin (c): pendingLaunch survives the disk round-trip', () => {
  it('projectToFile → serialize → parse → fileToProject keeps pendingLaunch', () => {
    const pending: PendingLaunch = { after: [], command: 'claude "do the thing"' }
    const armedState: CanvasNodeState = {
      id: 'term-cold1',
      kind: 'terminal',
      position: { x: 40, y: 60 },
      size: { width: 600, height: 400 },
      title: 'Claude',
      color: '#d97757',
      group: null,
      agentId: 'claude',
      pendingLaunch: pending
    }
    const project: Project = {
      id: 'project-a',
      name: 'repoA',
      color: '#888',
      cwd: '/tmp/repoA',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [armedState]
    }
    const file = projectToFile(project, 1, new Date(0).toISOString())
    const parsed = JSON.parse(serializeProjectFile(file))
    const loaded = fileToProject(parsed, { id: 'project-a', cwd: '/tmp/repoA' })
    expect(loaded.nodes[0].pendingLaunch).toEqual(pending)
  })
})
