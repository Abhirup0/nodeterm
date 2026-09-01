import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNodeState } from '../shared/types'
import type { TriggerSpec } from '../shared/trigger'
import { startTriggerService, type TriggerService } from './trigger-service'

const MIN = 60_000
const T0 = new Date(2026, 8, 2, 12, 0).getTime()

const spec = (): TriggerSpec => ({
  schedule: { kind: 'interval', everyMinutes: 5 },
  payload: 'npm test',
  target: 'term-tgt-1'
})

const node = (partial: Partial<CanvasNodeState> & { id: string }): CanvasNodeState => ({
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 1, height: 1 },
  title: '',
  color: '',
  group: null,
  ...partial
})

describe('startTriggerService (end to end over fakes)', () => {
  let dir: string
  let service: TriggerService
  let clock: { t: number }
  let sent: string[]
  let nodes: CanvasNodeState[]

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-trigger-svc-'))
    clock = { t: T0 }
    sent = []
    // A trigger node and its PLAIN-TERMINAL target (shell pane ⇒ deliverable without any
    // agent-status mirror state, which this test deliberately leaves untouched).
    nodes = [
      node({ id: 'trigger-a-1', kind: 'trigger', trigger: spec() }),
      node({ id: 'term-tgt-1' })
    ]
    service = startTriggerService({
      userDataDir: dir,
      listCanvases: () => [{ id: 'project-1', nodes }],
      getNode: (id) => nodes.find((n) => n.id === id),
      sendText: async (_id, text) => {
        sent.push(text)
        return true
      },
      paneCommand: async () => 'bash',
      now: () => clock.t
    })
  })

  afterEach(async () => {
    service.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('an armed trigger fires end to end; a disarmed one never does', async () => {
    await service.scheduler.sweepOnce() // anchor
    clock.t = T0 + 5 * MIN
    await service.scheduler.sweepOnce() // due, but DISARMED (nothing ever armed it)
    expect(sent).toHaveLength(0)

    expect(await service.armStore.arm('project-1', 'trigger-a-1', spec())).toBe(true)
    clock.t = T0 + 10 * MIN
    await service.scheduler.sweepOnce()
    expect(sent).toEqual(['npm test'])
    const runs = service.scheduler.runsFor('project-1', 'trigger-a-1')
    expect(runs.map((r) => r.outcome)).toEqual(['fired'])
  })

  it('the arm binds to content across the whole service: an edited spec stops firing', async () => {
    await service.armStore.arm('project-1', 'trigger-a-1', spec())
    await service.scheduler.sweepOnce()
    // A git pull rewrites the payload. The next sweep re-anchors (spec changed) and every
    // due check re-asks the content-bound arm gate, which now says no.
    nodes[0] = node({
      id: 'trigger-a-1',
      kind: 'trigger',
      trigger: { ...spec(), payload: 'rm -rf /' }
    })
    clock.t = T0 + 5 * MIN
    await service.scheduler.sweepOnce() // re-anchor on the new content
    clock.t = T0 + 15 * MIN
    await service.scheduler.sweepOnce() // due — disarmed for THIS content
    expect(sent).toHaveLength(0)
  })
})
