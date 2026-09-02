import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural pins for the canvas edge model (spec: docs/superpowers/specs/2026-09-02-canvas-edge-
 * model-design.md). The decisions are proven against real primitives in lib/edgeModel.test.ts and
 * lib/floatingEdge.test.ts; what only the source can state is that Canvas consults them and that
 * the families it replaced are gone.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')

describe('canvas edge model (source pins)', () => {
  it('every edge is a floating edge — no family picks a fixed handle side any more', () => {
    expect(src).toContain('edgeTypes={edgeTypes}')
    expect(src).not.toMatch(/sourceHandle:\s*'/)
    expect(src).not.toMatch(/targetHandle:\s*'/)
  })

  it('the separate "waits for" family is gone; the waiting look is the rope\'s, from the model', () => {
    expect(src).not.toContain('dependencyEdges')
    expect(src).not.toContain('depEdges')
    expect(src).not.toContain("'⏳ waits for'")
    expect(src).toContain('ropeVisual(')
    expect(src).toContain('WAIT_LABEL')
  })

  it('--after writes a rope from each dep to each opened node, beside the hidden bridge', () => {
    // One helper, three verbs: the rope id shape is what hiddenLinkIds / delete key on.
    expect(src).toMatch(/const ropeDeps = \(ids: string\[\], after: string\[\] \| undefined\)/)
    expect(src).toContain('ropeEdge(`ctrl-${dep}-${nid}`, dep, nid)')
    expect((src.match(/ropeDeps\(ids, after\)/g) ?? []).length).toBe(2)
  })

  it('the eye hides every edge touching the node, on every family', () => {
    expect(src).toContain('hiddenEdgeNodeIds(')
    expect(src).toMatch(/\.filter\(\(e\) => !edgeHidden\(e, hidden\)\)/)
  })

  it('deleting a waiting rope disarms that one dep (both the ⌫ path and double-click)', () => {
    expect(src).toContain('const disarmDepsFor = useCallback(')
    expect((src.match(/disarmDepsFor\(\[?[a-zA-Z.]+\]?\)/g) ?? []).length).toBeGreaterThanOrEqual(2) // ⌫ path + double-click
    expect(src).toContain('dropAfterDep(')
  })
})
