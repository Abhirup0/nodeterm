import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '../shared/types'
import type { TriggerSpec } from '../shared/trigger'
import { fileToProject, projectToFile, sanitizeNodeTriggers } from './workspace-files'

const spec = (): TriggerSpec => ({
  schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
  payload: 'npm run report',
  target: 'term-tgt-1',
  note: 'daily report'
})

const triggerNode = (extra?: Partial<CanvasNodeState>): CanvasNodeState => ({
  id: 'trigger-a-1',
  kind: 'trigger',
  position: { x: 10, y: 20 },
  size: { width: 300, height: 170 },
  title: 'Daily report',
  color: '#888',
  group: null,
  trigger: spec(),
  ...extra
})

const project = (nodes: CanvasNodeState[]): Project => ({
  id: 'project-1',
  name: 'Test',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes
})

describe('sanitizeNodeTriggers', () => {
  it('keeps a valid spec on a trigger node and normalizes it', () => {
    const smuggled = { ...triggerNode(), trigger: { ...spec(), armed: true } as never }
    const [out] = sanitizeNodeTriggers([smuggled])
    expect(out.trigger).toEqual(spec())
    expect(Object.keys(out.trigger!)).not.toContain('armed')
  })

  it('drops a malformed spec — the node survives, inert', () => {
    const [out] = sanitizeNodeTriggers([
      triggerNode({ trigger: { schedule: { kind: 'weekly' } } as never })
    ])
    expect(out.id).toBe('trigger-a-1')
    expect(out.trigger).toBeUndefined()
  })

  it('drops a trigger spec sitting on a non-trigger node', () => {
    const [out] = sanitizeNodeTriggers([triggerNode({ kind: 'terminal' })])
    expect(out.trigger).toBeUndefined()
  })

  it('leaves nodes without a spec untouched (identity preserved)', () => {
    const plain = triggerNode({ trigger: undefined })
    delete (plain as { trigger?: unknown }).trigger
    const [out] = sanitizeNodeTriggers([plain])
    expect(out).toBe(plain)
  })
})

describe('project file boundary', () => {
  it('round-trips a valid trigger node through projectToFile → fileToProject', () => {
    const file = projectToFile(project([triggerNode()]), 1, '2026-08-29T00:00:00Z')
    expect(file.nodes[0].trigger).toEqual(spec())
    const back = fileToProject(file, { id: 'project-1' })
    expect(back.nodes[0].kind).toBe('trigger')
    expect(back.nodes[0].trigger).toEqual(spec())
  })

  it('a hostile file cannot deliver a malformed or misplaced spec', () => {
    const file = projectToFile(project([triggerNode()]), 1, '2026-08-29T00:00:00Z')
    const hostile = {
      ...file,
      nodes: [
        { ...file.nodes[0], trigger: { ...spec(), payload: 'x'.repeat(20_000) } },
        { ...triggerNode({ id: 'term-b-1', kind: 'terminal' }) }
      ]
    }
    const back = fileToProject(hostile, { id: 'project-1' })
    expect(back.nodes[0].trigger).toBeUndefined()
    expect(back.nodes[1].trigger).toBeUndefined()
  })

  it('never writes a malformed spec into the shared file', () => {
    const bad = triggerNode({ trigger: { schedule: null } as never })
    const file = projectToFile(project([bad]), 1, '2026-08-29T00:00:00Z')
    expect(file.nodes[0].trigger).toBeUndefined()
  })

  it('the shared file carries no arm state in any shape', () => {
    // The machine-local arm store is the ONLY carrier of consent; the file's serialized bytes
    // must never contain an armed-looking field, whatever a future refactor threads through.
    const file = projectToFile(project([triggerNode()]), 1, '2026-08-29T00:00:00Z')
    const raw = JSON.stringify(file)
    expect(raw).not.toMatch(/armed/i)
    expect(raw).not.toMatch(/localTriggerArm/)
  })
})
