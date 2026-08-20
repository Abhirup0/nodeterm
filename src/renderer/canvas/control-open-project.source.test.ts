import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the `open-project` early-handled dispatch block (issue #338 Task 2.2) —
 * the same class of test as `control-destructive.test.ts`, and for the same reason: the block
 * lives inside a 7000-line React component's IPC listener with no unit seam, and the properties
 * pinned here are properties of the SOURCE (what the block calls and what it never calls). Every
 * behavioural half is separately proven against real primitives: the consent decision in
 * `projectOpen.test.ts` (planOpenProject on the real ledger), the store action in
 * `projects.register.test.ts` (registerProject never activates), the grant in main's
 * `project-grants.test.ts`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

/** The early-handled open-project block: from its `if (verb === ...)` guard to the next
 *  section-rule comment (`// ──`) — the same delimiting `control-destructive.test.ts` uses. */
function openProjectBody(): string {
  const start = src.indexOf(`if (verb === 'open-project')`)
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.indexOf('// ──', 10)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the open-project dispatch block (source pins)', () => {
  it('sits BEFORE the source-routing machinery — ahead of the routeControlSource lookup', () => {
    // The store-answered declaration (controlRouting.ts) and this early-exit are the same
    // decision stated once each (spec §2.3): the block must run before the dispatch ever
    // consults routeControlSource, or a background caller's open-project would travel the
    // human's view to the CALLER's project (G5).
    const block = src.indexOf(`if (verb === 'open-project')`)
    const routing = src.indexOf('routeControlSource(projects, activeId, sourceNodeId)')
    expect(block).toBeGreaterThan(-1)
    expect(routing).toBeGreaterThan(-1)
    expect(block).toBeLessThan(routing)
  })

  it('never activates or travels (spec P6): no setActive, no travelToProject in any branch', () => {
    const body = openProjectBody()
    expect(body).not.toContain('setActive')
    expect(body).not.toContain('travelToProject')
    expect(body).not.toContain('reopenProject')
    expect(body).not.toContain('openFolderProject')
    expect(body).not.toContain('adoptProject')
  })

  it('every store change goes through the non-activating registerProject, and only in opFinish', () => {
    const body = openProjectBody()
    // registerProject is reached exactly once, inside the single opFinish closure both the
    // silent hit and the confirmed dialog call — so a denial (onCancel) structurally cannot
    // create anything: the only creation site is behind opFinish.
    expect(body.match(/registerProject\(/g)?.length).toBe(1)
    expect(body).toContain('const opFinish')
    // The cancel leg replies the shared denial and calls nothing else.
    expect(body).toMatch(/onCancel: \(\) => reply\(\{ ok: false, error: 'denied by user' \}\)/)
  })

  it('the dialog shows the plan message (built from the RESOLVED cwd, P5), not a re-derived path', () => {
    const body = openProjectBody()
    expect(body).toContain('message: opPlan.message')
    // The block never re-resolves or re-derives the path: args.cwd (main's resolved form) is
    // read once into resolvedCwd and that identifier is what the plan and the store see.
    expect(body).toContain('const resolvedCwd = args.cwd')
  })

  it('persists after registering (writeDisk inside opFinish)', () => {
    const body = openProjectBody()
    const finishStart = body.indexOf('const opFinish')
    const finishEnd = body.indexOf('// The probe only matters')
    const finish = body.slice(finishStart, finishEnd)
    expect(finish).toContain('writeDisk()')
  })
})
