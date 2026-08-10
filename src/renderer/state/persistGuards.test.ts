import { describe, it, expect } from 'vitest'
import { canCommitCanvas } from './persistGuards'

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
