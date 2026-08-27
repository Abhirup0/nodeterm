import { describe, it, expect } from 'vitest'
import { canCommitCanvas, canClearDirty, canCreateOnCanvas } from './persistGuards'

describe('canCommitCanvas', () => {
  it('commits while the nodes in hand belong to the active project', () => {
    expect(canCommitCanvas('a', 'a')).toBe(true)
  })

  // The field bug (2026-08-10): the 800ms autosave timer is armed under project A, the user
  // switches to B (zustand updates synchronously), and the timer fires BEFORE the load effect has
  // installed B's nodes — so A's nodes would be committed under B's id, wiping B.
  it('refuses to commit one project canvas under another project id', () => {
    expect(canCommitCanvas('a', 'b')).toBe(false)
  })

  // Before the first load effect runs, React Flow holds the initial `useNodesState([])` — an empty
  // array that belongs to NO project. Committing it is the "both canvases went blank" wipe.
  it('refuses to commit nodes that belong to no project yet', () => {
    expect(canCommitCanvas(null, 'a')).toBe(false)
  })

  // No project open (welcome screen): there is no id to write under.
  it('refuses to commit with no active project', () => {
    expect(canCommitCanvas('a', '')).toBe(false)
    expect(canCommitCanvas(null, '')).toBe(false)
    expect(canCommitCanvas('', '')).toBe(false)
  })
})

describe('canCreateOnCanvas', () => {
  it('creates while the canvas on screen belongs to the active project', () => {
    expect(canCreateOnCanvas('a', 'a')).toBe(true)
  })

  // Issue #443: the store already says B (a tab switch, or a bailed load effect that left the
  // previous nodes mounted) while A's canvas is what the user sees. Creating here would insert
  // the node into A's canvas but stamp B's cwd / account default / launch command onto it — for
  // an agent session that is silent write access to the wrong repo. Refuse (the caller says so
  // loudly); never resolve the project from ambient state that disagrees with the screen.
  it('refuses to create while the canvas shows a different project than the active one', () => {
    expect(canCreateOnCanvas('a', 'b')).toBe(false)
  })

  // Before the first load effect, or after a bailed one, React Flow's nodes belong to NO project.
  it('refuses to create before any project canvas is installed', () => {
    expect(canCreateOnCanvas(null, 'a')).toBe(false)
  })

  it('refuses to create with no active project', () => {
    expect(canCreateOnCanvas('a', '')).toBe(false)
    expect(canCreateOnCanvas(null, '')).toBe(false)
  })
})

describe('canClearDirty', () => {
  it('clears dirty when nothing changed while the save was in flight', () => {
    expect(canClearDirty(7, 7)).toBe(true)
  })

  // Field bug 2026-08-10: a save can take seconds (SSH mirror write). Edits made DURING the await
  // are not in the snapshot handed to the store, so clearing dirty marks them saved — and the
  // watcher's not-dirty branch then clobbers them with a replaceProject + reload. Keep dirty set;
  // the debounce re-saves.
  it('keeps dirty set when an edit landed during the save', () => {
    expect(canClearDirty(7, 8)).toBe(false)
  })

  it('keeps dirty set for a burst of edits during one save', () => {
    expect(canClearDirty(0, 12)).toBe(false)
  })
})
