// @vitest-environment jsdom
//
// Two things Canvas.tsx wires that nothing else could see it stop wiring.
//
// Canvas is a monolith with no render harness, so the pieces below are pinned where they live: the
// chrome opt-in by RENDERING the cluster that carries it and asking `chromeObstacles` for it, and
// the wiring by reading the call site. A source read is a weak test in general, but it is the only
// thing standing between a one-character deletion and a silently reintroduced bug — which is
// exactly the shape that survived the whole suite once on this branch already.
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromeObstacles, FIT_VIEW_GAP } from './fit-view'

const CANVAS_SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8')

/** jsdom lays nothing out, so every rect is 0×0 and `chromeObstacles`'s size filter would drop the
 *  element. Give it the measurement a real bottom-left pill cluster has. */
function measured(el: Element, r: { left: number; top: number; right: number; bottom: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top }) as DOMRect
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the canvas pill cluster is fit-view chrome', () => {
  const VIEWPORT = { left: 0, top: 0, right: 1200, bottom: 800 }
  const PILLS = { left: 60, top: 740, right: 300, bottom: 766 }

  it('is picked up as an obstacle through data-canvas-chrome', () => {
    // Exactly the markup Canvas renders: the ATTRIBUTE is the whole opt-in — `.canvas-pills` is not
    // in CANVAS_CHROME_SELECTOR, so nothing else can reach this element.
    document.body.innerHTML = '<div class="canvas-pills" data-canvas-chrome></div>'
    const el = document.querySelector('.canvas-pills')!
    measured(el, PILLS)
    const obstacles = chromeObstacles(VIEWPORT)
    expect(obstacles).toHaveLength(1)
    // Inflated by the gap, so fitView keeps content clear of the pills rather than flush against.
    expect(obstacles[0]).toEqual({
      left: PILLS.left - FIT_VIEW_GAP,
      top: PILLS.top - FIT_VIEW_GAP,
      right: PILLS.right + FIT_VIEW_GAP,
      bottom: PILLS.bottom + FIT_VIEW_GAP
    })
  })

  it('is invisible to fit-view without the attribute', () => {
    // The failure this pins: dropping `data-canvas-chrome` leaves a rendering, clickable cluster and
    // a fitView that parks nodes underneath it — no error, no test, nothing to notice.
    document.body.innerHTML = '<div class="canvas-pills"></div>'
    measured(document.querySelector('.canvas-pills')!, PILLS)
    expect(chromeObstacles(VIEWPORT)).toEqual([])
  })

  it('is what Canvas actually renders', () => {
    expect(CANVAS_SRC).toContain('<div className="canvas-pills" data-canvas-chrome>')
  })
})

describe('the session-memory panel is the one caller that fans a kill across sockets', () => {
  // Both legs of the panel's speculative kill (see `localKillSockets`): its rows are swept off BOTH
  // of the machine's tmux sockets, so a row it offers to end can be on either. Every other caller
  // knows its own nodes and must stay narrow, which is why the flag is opt-in — and why dropping it
  // here restores the exact bug the confirm used to lie about, with the whole suite green.
  it('asks for every socket on the local destroy and the remote kill', () => {
    expect(CANVAS_SRC).toContain("transport.destroy(nodeId, { everySocket: true })")
    expect(CANVAS_SRC).toContain(
      ".killSessions(plan.remoteProjectId!, [nodeId], { everySocket: true })"
    )
  })

  it('leaves project deletion narrow', () => {
    // The other `killSessions` call site (deleteProject) passes ids and nothing else. `node-terminal`
    // on that host belongs to a nodeterm running ON it, not to the project being deleted.
    expect(CANVAS_SRC).toContain('.killSessions(id, nodeIds)')
  })
})

describe('the zoom chords go through their guarded decision, on both routes', () => {
  // `lib/zoomShortcut.ts` owns when ⌘0 / Shift+1 may move the camera (not while the kanban board
  // covers the canvas, not while the user is typing). It is tested thoroughly on its own — what
  // nothing else can see is Canvas calling round it. Both failures are silent: a raw
  // `zoomShortcutChord` dispatch would fire under the board, and a bare `zoomTo100()` on the
  // forwarded desktop route would fire mid-keystroke in a terminal.
  it('asks the live decision on the keydown route', () => {
    expect(CANVAS_SRC).toContain('const action = liveZoomShortcutAction(e)')
    expect(CANVAS_SRC).toContain("if (action === 'zoom-100') zoomTo100()")
  })

  it('re-asks the refusals on the ⌘0 route forwarded from main', () => {
    expect(CANVAS_SRC).toContain(
      'if (zoomShortcutAllowed(liveZoomShortcutContext())) zoomTo100()'
    )
  })
})

describe('the trailing gestures are handed to the dispatcher', () => {
  // The checks above read the gesture BODIES, which is one hop short: `zoomGesture` can be
  // perfectly wired internally and simply never reach `dispatchGlobalKeydown`. Deleting
  // `zoom: zoomGesture,` from the gestures object keeps every assertion in this file — and in
  // globalKeybindings.test.ts, which supplies its own fakes — green while Shift+1 and the
  // keydown ⌘0 route quietly stop moving the camera. Same shape for the other two: the project
  // jump and the file-reference copy have no other call site either.
  it('wires zoom, projectJump and copy into the dispatcher deps', () => {
    expect(CANVAS_SRC).toContain('zoom: zoomGesture')
    expect(CANVAS_SRC).toContain('projectJump: projectJumpGesture')
    expect(CANVAS_SRC).toContain('copy: copyGesture')
  })
})

describe('the end-session confirm describes both things it does', () => {
  // `closeSession` stops the tmux session AND deletes the canvas node. The wording is inherited
  // from the sessions sidebar, where deleting the node is the obvious intent — but the
  // session-memory panel reuses the same path, and there the user came to reclaim RAM. Saying only
  // "this stops its tmux session" makes the node's removal a surprise on the one surface whose
  // purpose invites it. (Keeping the node would need a SECOND destroy path; deliberately not built.)
  it('says the node goes too, on every owned-session confirm', () => {
    const owned = CANVAS_SRC.match(/End this session\?[^']*/g) ?? []
    expect(owned.length).toBeGreaterThanOrEqual(3)
    for (const m of owned) {
      // The orphan row is the one exception, and it is honest: there is no node to remove.
      if (m.includes('no node on any canvas')) continue
      expect(m).toContain('removes the node from its canvas')
    }
  })
})

describe('breadcrumb wiring the CLAUDE.md bullet calls load-bearing', () => {
  // Same discipline as the dispatch-map pins above: Canvas has no render harness, and each of
  // these rules failed silently once (or would) — a source read is the only net.

  it('goToNode refuses to record the ephemeral subagent/loop viz nodes', () => {
    // A breadcrumb for one is an id nothing can ever resolve (they are cleared on the next turn),
    // permanently burning one of the 20 slots.
    expect(CANVAS_SRC).toContain("node.type !== 'subagent' && node.type !== 'loop'")
  })

  it('stepAndFrame never records — it frames through the shared frameNode, not goToNode', () => {
    const step = CANVAS_SRC.slice(
      CANVAS_SRC.indexOf('const stepAndFrame = useCallback'),
      CANVAS_SRC.indexOf('const goBack = useCallback')
    )
    expect(step.length).toBeGreaterThan(0)
    // Recording inside a step would turn every back-step into a new tip.
    expect(step).not.toContain('recordBreadcrumb')
    expect(step).not.toContain('goToNode(')
    // The single framing implementation — the "Go to node" origin-jump invariant has ONE copy.
    expect(step).toContain('frameNode(target)')
  })

  it('there is exactly ONE framing implementation (frameNode) shared by focus and steps', () => {
    // The measured-check-reads-the-store rule regresses through a second copy first.
    expect(CANVAS_SRC.match(/isMeasured\(internal\)/g) ?? []).toHaveLength(1)
  })

  it('the resume card slot is spent only on a card that can render, and only when opted in', () => {
    // Gated on settings.showResumeCard (default off) FIRST — a disabled card must not spend the
    // one-shot slot — then once per app run, only with a live stop, and never under the opaque
    // kanban overlay.
    expect(CANVAS_SRC).toContain(
      'resumeCardEnabled &&\n        !resumeCardShown.has(project.id) &&\n        hasLiveStop &&\n        !isKanbanOpen(project.id)'
    )
    expect(CANVAS_SRC).toContain(
      'const resumeCardEnabled = useSettings.getState().settings.showResumeCard'
    )
  })
})

describe('reopen-last-closed records and dispatches through the shared history stack', () => {
  it('records a project close before hiding it', () => {
    expect(CANVAS_SRC).toContain('useReopenHistory.getState().push({ kind: \'project\'')
  })

  it('records a node-delete batch, opting the account-removal cleanup out', () => {
    expect(CANVAS_SRC).toContain("kind: 'nodes'")
    expect(CANVAS_SRC).toContain('deleteNodes(loginIds, { record: false })')
  })

  it('registers the command in the dispatch map', () => {
    expect(CANVAS_SRC).toContain("'app.reopenLastClosed': reopenLastClosedCommand")
  })

  it('never live-inserts into a non-active project — routes through applyNodeMutation instead', () => {
    // The bug this pins: a synchronous setNodes() right after switchProject()/reopenProject()
    // races the active-project load effect and silently loses the recreated nodes.
    expect(CANVAS_SRC).toContain('.applyNodeMutation(plan.projectId, {')
  })

  it('arms a cold-open command before writing a restored node into a non-active project', () => {
    // The bug this pins: flowToNodeStates alone drops initialCommand, so an agent node restored
    // into a project that isn't on screen would never launch its command on the eventual cold
    // open — armForColdOpen is what carries it through serialization.
    expect(CANVAS_SRC).toContain('node: flowToNodeStates([armForColdOpen(node)])[0]')
  })

  it('commits the live canvas to the store before every reopenProject call — never a bare switch', () => {
    // The bug this pins: useProjects.getState().reopenProject(...) is a project SWITCH, and every
    // switch/add/delete elsewhere in this file calls commitActiveToStore() first so the live
    // canvas isn't silently lost. Both reopen-a-project call sites inside reopenLastClosedCommand
    // must do the same, rather than referencing the later `reopenProject` wrapper (a TDZ hazard
    // from this callback's declaration point).
    const calls = CANVAS_SRC.match(/useProjects\.getState\(\)\.reopenProject\(/g) ?? []
    const guarded = CANVAS_SRC.match(/commitActiveToStore\(\)\n\s+useProjects\.getState\(\)\.reopenProject\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(guarded.length).toBe(calls.length)
  })

  it('resolves permission mode against the TARGET project being restored into, not the caller\'s active one', () => {
    expect(CANVAS_SRC).toContain('permissionModeFor: (agentId) => projectPermissionMode(project, agentId)')
  })

  it('extracts the reopen decision into the pure, tested planReopen', () => {
    expect(CANVAS_SRC).toContain('const plan = planReopen(')
    expect(CANVAS_SRC).toContain("case 'insertActive':")
    expect(CANVAS_SRC).toContain("case 'insertStored':")
    expect(CANVAS_SRC).toContain("case 'reopenProject':")
  })
})

describe('node creation resolves its project LIVE and only onto a matching canvas (issue #443)', () => {
  // The bug this pins: the sessions-sidebar "+" switches projects and THEN opens the creation
  // menu, whose onClick closures were built under the PREVIOUS render and frozen into setMenu
  // state. A creation callback that closed over that render's `activeProjectId` charged the new
  // node to the OLD project — its cwd, its account default, its `.nodeterm/settings.json` launch
  // command — while inserting it into the NEW project's canvas. For an agent session that is
  // silent read/write access to the wrong repo. The rule: every creation funnel reads the active
  // project from the store AT CLICK TIME and pairs it with the canvas epoch tag before creating.
  it('reads the active project from the store at call time in every creation funnel', () => {
    const liveReads =
      CANVAS_SRC.match(/const targetProjectId = useProjects\.getState\(\)\.activeProjectId/g) ?? []
    // addAgentNode, addTerminal, createNodeInColumn, explainCommit.
    expect(liveReads.length).toBe(4)
  })

  it('guards every creation funnel with canCreateOnCanvas against the canvas epoch tag', () => {
    const guards =
      CANVAS_SRC.match(/canCreateOnCanvas\(nodesProjectIdRef\.current, targetProjectId\)/g) ?? []
    expect(guards.length).toBe(4)
  })

  it('refuses a mismatch loudly — a dead click with no message is how #443 stayed undiagnosable', () => {
    expect(CANVAS_SRC).toContain('node-create refused: canvas holds')
    expect(CANVAS_SRC).toContain(
      'the canvas on screen is not the active project’s. Switch tabs once and try again.'
    )
  })

  it('logs the spawn triple (project, group, cwd) so the next report is diagnosable', () => {
    const logs = CANVAS_SRC.match(/\[nodeterm\] node-create agent=/g) ?? []
    // addAgentNode + addTerminal.
    expect(logs.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves the created node\'s project record from the live target id, never the closure', () => {
    // The exact stale read the bug shipped with: `getProject(activeProjectId)` inside a creation
    // funnel, where `activeProjectId` is the RENDER's value. Every creation funnel now pairs its
    // guard with `getProject(targetProjectId)`; a reintroduced closure read would bring #443 back
    // with the whole suite green.
    const liveRecordReads =
      CANVAS_SRC.match(/const project = useProjects\.getState\(\)\.getProject\(targetProjectId\)/g) ?? []
    expect(liveRecordReads.length).toBe(4)
  })
})
