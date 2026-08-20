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

/** The `--project` targeted-opens block (Task 2.3): from its section rule to the end-of-early
 *  marker. */
function targetedOpensBody(): string {
  const start = src.indexOf('// ── `--project` targeted opens')
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.indexOf('// ── end of the early-handled')
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

describe('the --project targeted-opens block (source pins)', () => {
  it('sits BEFORE the source-routing machinery, like open-project', () => {
    const block = src.indexOf('// ── `--project` targeted opens')
    const routing = src.indexOf('routeControlSource(projects, activeId, sourceNodeId)')
    expect(block).toBeGreaterThan(-1)
    expect(block).toBeLessThan(routing)
  })

  it('never activates or travels (B4)', () => {
    const body = targetedOpensBody()
    expect(body).not.toContain('setActive')
    expect(body).not.toContain('travelToProject')
  })

  it('the gate order is refusal-before-write: every refusal precedes every store/canvas write', () => {
    // A refused target must write NOTHING. The flag refusal, the source checks, the
    // unknown-target belt and the SSH belt all return before the first applyNodeMutation or
    // setNodes — moving a write above any of them is the gate-before-write mutation.
    const body = targetedOpensBody()
    const firstWrite = Math.min(
      ...['applyNodeMutation', 'setNodes'].map((s) => {
        const i = body.indexOf(s)
        return i === -1 ? body.length : i
      })
    )
    for (const refusal of [
      // The flag exclusion is decided by the pure projectTargetFlagRefusal (its logic is
      // red-capable in projectOpen.test.ts — review #363 I-2); here we pin its CALL SITE's
      // position, like the inline refusals below.
      'projectTargetFlagRefusal(args)',
      'project-target-refused',
      'project-target-ssh-unsupported',
      'source node is not a control-capable agent'
    ]) {
      const at = body.indexOf(refusal)
      expect(at, refusal).toBeGreaterThan(-1)
      expect(at, `${refusal} after a write`).toBeLessThan(firstWrite)
    }
  })

  it('the flag-exclusion guard FIRES on a truthy refusal — polarity pinned (review #363 I-2)', () => {
    // The helper's decision logic is behaviorally tested; what only the source can show is that
    // the dispatch honors the answer with the right polarity. `if (!tgFlagRefusal)` — the
    // guard-inversion mutation that survived the original suite — no longer matches this.
    const body = targetedOpensBody()
    expect(body).toMatch(
      /const tgFlagRefusal = projectTargetFlagRefusal\(args\)\s+if \(tgFlagRefusal\) \{\s+reply\(\{ ok: false, error: tgFlagRefusal \}\)\s+return/
    )
  })

  it('the store path arms through armForColdOpen — the launch survives serialization', () => {
    // flowToNodeStates drops initialCommand by design; upserting a node without moving its
    // command into pendingLaunch is the silent-never-starts mutation (Task 2.0's pins prove the
    // round-trip; this pins that the store path actually uses the mover).
    const body = targetedOpensBody()
    expect(body).toMatch(/flowToNodeStates\(\[armForColdOpen\(node\)\]\)\[0\]/)
  })

  it('the store path persists (writeDisk) and states the cold-open contract in the reply', () => {
    const body = targetedOpensBody()
    expect(body).toContain('writeDisk()')
    expect(body).toContain('starts when that project is next viewed')
  })

  it('the caller’s OWN project id falls through to the legacy path (B3a) — no return on that leg', () => {
    const body = targetedOpensBody()
    expect(body).toContain('if (targetId !== callerProjectId)')
    expect(body).toContain('fall through to the legacy path unchanged')
  })

  it('draws no ropes and no context-links in either branch (v1 — #284’s half)', () => {
    const body = targetedOpensBody()
    expect(body).not.toContain('addAndConnect')
    expect(body).not.toContain('bridgeTo')
    expect(body).not.toContain('connect(')
  })
})
