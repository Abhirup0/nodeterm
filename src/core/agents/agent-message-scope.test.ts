import { describe, it, expect } from 'vitest'
import { resolveDeliveryScope, scopeRefusal, type ScopeProject } from './agent-message-scope'
import { decideDelivery, decidePreProbe, RETRYABLE } from './agent-message-decide'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { DeliveryFacts } from './agent-message-decide'

/** Two projects, both with sessions running — the store holds every open AND closed project. */
const projects: ScopeProject[] = [
  { id: 'p-alpha', nodes: [{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }] },
  { id: 'p-beta', nodes: [{ id: 'b-1' }, { id: 'b-2' }] }
]

/** Every other gate passing, so the only thing a refusal can be attributed to is the scope. */
const facts = (over: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  targetLive: true,
  pane: 'agent',
  target: { state: 'done', updatedAt: 1000, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION },
  tokenFilePresent: true,
  pasteAware: true,
  ...over
})

describe('resolveDeliveryScope', () => {
  it('admits two nodes in the same project, and names it', () => {
    expect(resolveDeliveryScope(projects, 'a-1', 'a-2')).toEqual({
      kind: 'same-project',
      projectId: 'p-alpha'
    })
    expect(resolveDeliveryScope(projects, 'b-1', 'b-2')).toEqual({
      kind: 'same-project',
      projectId: 'p-beta'
    })
  })

  it('refuses a target in ANOTHER project, and says the target exists', () => {
    expect(resolveDeliveryScope(projects, 'a-1', 'b-1')).toEqual({
      kind: 'refused',
      reason: 'cross-project',
      targetFound: true
    })
  })

  it('refuses a target that resolves nowhere, and says so', () => {
    // Same refusal, different fact behind it: `targetFound: false` is what separates "aimed at
    // another project" from "aimed at nothing", and only one of those is worth a human's time.
    expect(resolveDeliveryScope(projects, 'a-1', 'ghost')).toEqual({
      kind: 'refused',
      reason: 'cross-project',
      targetFound: false
    })
  })

  it('refuses when the SOURCE belongs to no project the store knows — fail closed', () => {
    // The thing being authorised is a write into someone else's terminal. Anything that cannot be
    // positively resolved to one shared project is refused; there is no benefit of the doubt.
    expect(resolveDeliveryScope(projects, 'ghost', 'a-1')).toEqual({
      kind: 'refused',
      reason: 'cross-project',
      targetFound: true
    })
    expect(resolveDeliveryScope([], 'a-1', 'a-2')).toEqual({
      kind: 'refused',
      reason: 'cross-project',
      targetFound: false
    })
  })

  it('refuses a self-send wherever the id lives, or does not', () => {
    expect(resolveDeliveryScope(projects, 'a-1', 'a-1')).toEqual({
      kind: 'refused',
      reason: 'self-send',
      targetFound: true
    })
    expect(resolveDeliveryScope(projects, 'ghost', 'ghost')).toEqual({
      kind: 'refused',
      reason: 'self-send',
      targetFound: false
    })
  })

  it('a node the LIVE canvas has but the store does not is refused, not admitted', () => {
    // The guarantee behind "resolved against the serialized store, not `nodesRef`": there is no
    // parameter here for a live node list, so a node that exists only on the live canvas is simply
    // absent — and absent fails closed. A freshly created node is not a verified idle agent yet
    // either, so nothing deliverable is lost.
    const justCreatedOnCanvas = 'a-9'
    expect(resolveDeliveryScope(projects, 'a-1', justCreatedOnCanvas)).toEqual({
      kind: 'refused',
      reason: 'cross-project',
      targetFound: false
    })
  })

  it('REFUSES a DUPLICATE target id — the one global pane cannot be attributed to one project’s grant', () => {
    // A `project.json` that merely LISTS another project's node id (a clone, or a hostile file)
    // resolves "same-project" by node-set membership, but the session namespace is the BARE id:
    // both listings name ONE tmux pane, and only one of the projects may hold the messaging grant.
    // PR #237 review I-1 proved the escalation by execution (granted A delivered into ungranted
    // B's pane), so ambiguity is now a refusal in BOTH directions — the resolver cannot prove
    // which project's pane the caller means, and "pick the sender's" was exactly the hole.
    const cloned: ScopeProject[] = [
      { id: 'p-alpha', nodes: [{ id: 'a-1' }, { id: 'dup' }] },
      { id: 'p-clone', nodes: [{ id: 'c-1' }, { id: 'dup' }] }
    ]
    expect(resolveDeliveryScope(cloned, 'a-1', 'dup')).toEqual({
      kind: 'refused',
      reason: 'ambiguous-target-node-id',
      targetFound: true
    })
    expect(resolveDeliveryScope(cloned, 'c-1', 'dup')).toEqual({
      kind: 'refused',
      reason: 'ambiguous-target-node-id',
      targetFound: true
    })
  })

  it('the ambiguity refusal names its own reason, not cross-project — different fact, different action', () => {
    // cross-project = "you two do not share a project"; ambiguous = "the id names panes in more
    // than one, and one of them may be ungranted". The human fixes the second by de-duplicating
    // ids (re-adding the cloned folder mints fresh ones), not by moving nodes between projects.
    const cloned: ScopeProject[] = [
      { id: 'p-alpha', nodes: [{ id: 'a-1' }, { id: 'dup' }] },
      { id: 'p-clone', nodes: [{ id: 'dup' }] }
    ]
    const scope = resolveDeliveryScope(cloned, 'a-1', 'dup')
    const outcome = decideDelivery(facts({ notPermitted: scopeRefusal(scope) }))
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'ambiguous-target-node-id' })
    expect(RETRYABLE.notPermitted).toBe(false)
  })

  it('a UNIQUE target still resolves, whatever else the projects carry', () => {
    // The refusal must not cost the legitimate population: same store shape, no duplicate.
    const cloned: ScopeProject[] = [
      { id: 'p-alpha', nodes: [{ id: 'a-1' }, { id: 'mine' }] },
      { id: 'p-clone', nodes: [{ id: 'c-1' }] }
    ]
    expect(resolveDeliveryScope(cloned, 'a-1', 'mine')).toEqual({
      kind: 'same-project',
      projectId: 'p-alpha'
    })
  })

  it('does not care whether the project tab is closed — a delivery goes to a pane', () => {
    // A closed project's tmux sessions keep running and are re-adopted on the next start; that is
    // the premise `routeControlSource` is built on. Filtering closed projects out would refuse a
    // perfectly deliverable message on the grounds that a tab is shut.
    const closed = [{ id: 'p-alpha', closed: true, nodes: [{ id: 'a-1' }, { id: 'a-2' }] }]
    expect(resolveDeliveryScope(closed, 'a-1', 'a-2')).toEqual({
      kind: 'same-project',
      projectId: 'p-alpha'
    })
  })

  it('ids are matched exactly — a case-folded near-miss is not the same node', () => {
    expect(resolveDeliveryScope(projects, 'a-1', 'A-2').kind).toBe('refused')
  })
})

describe('an id the app could never have made is refused before anything else', () => {
  // Node ids come off `.nodeterm/project.json` and the load path validates nothing, so this is the
  // only place on the messaging path that asks. Two things break without it: the pair limiter's
  // key stops being injective (its separator is a NUL), and tmux session names FOLD, because
  // `sessionName()` sanitises rather than refuses — declared `v/1` and `v_1` are one session.
  const SEP = String.fromCharCode(0)
  const unsafe = ['a 1', `a${SEP}1`, 'v/1', '../etc', '..', '', 'a$1', 'x'.repeat(129)]

  it.each(unsafe)('refuses %j as a TARGET', (id) => {
    const scope = resolveDeliveryScope([{ id: 'p', nodes: [{ id: 'a-1' }, { id }] }], 'a-1', id)
    expect(scope).toEqual({ kind: 'refused', reason: 'unaddressable-node-id', targetFound: true })
  })

  it.each(unsafe)('refuses %j as a SOURCE', (id) => {
    const scope = resolveDeliveryScope([{ id: 'p', nodes: [{ id }, { id: 'a-1' }] }], id, 'a-1')
    expect(scope.kind).toBe('refused')
    expect((scope as { reason: string }).reason).toBe('unaddressable-node-id')
  })

  it('refuses it even when BOTH nodes are listed in the same project — this is not a scope failure', () => {
    // Which is exactly why the word is its own: such an id can be sitting in the sender's own
    // project file, so calling it `cross-project` would be a false statement about the reason.
    const both = [{ id: 'p', nodes: [{ id: 'a 1' }, { id: 'a 2' }] }]
    expect(resolveDeliveryScope(both, 'a 1', 'a 2').kind).toBe('refused')
    expect(resolveDeliveryScope(both, 'a-1', 'a-2')).toEqual({
      kind: 'refused',
      reason: 'cross-project',
      targetFound: false
    })
  })

  it('is decided BEFORE the self-send arm — an unaddressable id is not a self-send', () => {
    // Both refusals are terminal, so this is about the WORD: "that is not a node id" and "you may
    // not message yourself" need different actions from whoever reads it.
    expect(resolveDeliveryScope([{ id: 'p', nodes: [{ id: 'a 1' }] }], 'a 1', 'a 1')).toEqual({
      kind: 'refused',
      reason: 'unaddressable-node-id',
      targetFound: true
    })
  })

  it('the two ids that would FOLD to one tmux session are both refused', () => {
    const folding = [{ id: 'p', nodes: [{ id: 'v/1' }, { id: 'v_1' }] }]
    // `v_1` is a legal id; `v/1` is the one that sanitises onto it, and it never gets that far.
    expect(resolveDeliveryScope(folding, 'v_1', 'v/1')).toEqual({
      kind: 'refused',
      reason: 'unaddressable-node-id',
      targetFound: true
    })
  })

  it('the ids the app actually emits are all still admitted', () => {
    // The check must not cost a legitimate population: `nextId()` emits `<prefix>-<base36>-<n>`
    // and `uuid()` hex-with-dashes.
    const real = ['term-mabc-3', 'claude-mb1x2y-11', '3f9a1c22-7b0e-4a11-9f00-0c1d2e3f4a5b', 'a.b_c-1']
    for (const id of real) {
      const scope = resolveDeliveryScope([{ id: 'p', nodes: [{ id: 'src-1' }, { id }] }], 'src-1', id)
      expect(scope, id).toEqual({ kind: 'same-project', projectId: 'p' })
    }
  })

  it('carries through decideDelivery as its own notPermitted reason, and is terminal', () => {
    const scope = resolveDeliveryScope([{ id: 'p', nodes: [{ id: 'a-1' }] }], 'a-1', 'a 2')
    const outcome = decideDelivery(facts({ notPermitted: scopeRefusal(scope) }))
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'unaddressable-node-id' })
    expect(RETRYABLE.notPermitted).toBe(false)
  })
})

describe('scopeRefusal feeds decideDelivery, and the refusal is terminal', () => {
  it('a cross-project target is notPermitted{cross-project} and is NOT retryable', () => {
    const scope = resolveDeliveryScope(projects, 'a-1', 'b-1')
    const outcome = decideDelivery(facts({ notPermitted: scopeRefusal(scope) }))
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'cross-project' })
    expect(RETRYABLE.notPermitted).toBe(false)
  })

  it('a same-project target contributes no refusal at all', () => {
    const scope = resolveDeliveryScope(projects, 'a-1', 'a-2')
    expect(scopeRefusal(scope)).toBeUndefined()
    expect(decideDelivery(facts({ notPermitted: scopeRefusal(scope) })).kind).toBe('proceed')
  })

  it('the refusal is decided PRE-PROBE, with no pane fact at all', () => {
    const scope = resolveDeliveryScope(projects, 'a-1', 'b-1')
    expect(
      decidePreProbe({
        targetLive: true,
        tokenFilePresent: true,
        target: undefined,
        notPermitted: scopeRefusal(scope)
      })
    ).toEqual({ kind: 'notPermitted', reason: 'cross-project' })
  })
})

describe('the self-send guard that already exists in the decider (PR #207) still holds', () => {
  it('refuses a self-send even when the caller passes no scope verdict at all', () => {
    // Verified, not re-implemented: `decidePreProbe` carries its own backstop so that no future
    // caller — PR 7's deliver-on-idle queue above all — can forget the outer guard and let a node
    // message itself in a loop with a rate limiter for a brake.
    expect(decideDelivery(facts({ sourceNodeId: 'a-1', targetNodeId: 'a-1' }))).toEqual({
      kind: 'notPermitted',
      reason: 'self-send'
    })
  })

  it('the two guards agree on the word, so a trace cannot depend on which one fired', () => {
    const outer = scopeRefusal(resolveDeliveryScope(projects, 'a-1', 'a-1'))
    const inner = decideDelivery(facts({ sourceNodeId: 'a-1', targetNodeId: 'a-1' }))
    expect(inner).toEqual({ kind: 'notPermitted', reason: outer })
  })

  it('the backstop is ahead of the rate limiter, so a self-send is never reported as a wait', () => {
    expect(
      decideDelivery(facts({ sourceNodeId: 'a-1', targetNodeId: 'a-1', retryAfterMs: 9999 })).kind
    ).toBe('notPermitted')
  })
})
