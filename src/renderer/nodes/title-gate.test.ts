// A guard over the TWO title gates, because the split is the whole point of the title lists.
//
// Reading a session's own name (`TITLE_READ_CAPABLE` — claude, grok, gemini) and PUSHING a name into
// a session (`RENAME_CAPABLE` — claude, grok) are different capabilities. Gating the poll on the
// write list costs gemini the title it names itself; gating a push on the read list types
// `/rename <name>` into a CLI that has no such command, in front of the user, on every rename.
//
// Neither `TerminalNode.tsx` nor `Canvas.tsx` is unit-rendered anywhere in this repo, so there is no
// behavioural test to catch either mistake — these are asserted over the SOURCE TEXT, the same
// technique `core/no-electron.test.ts` uses for the shell boundary. If a refactor moves a gate, the
// invariant is what matters: the poll reads, the push writes.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
const terminalNode = read('nodes/TerminalNode.tsx')
const canvas = read('canvas/Canvas.tsx')
const sessionRename = read('lib/sessionRename.ts')

describe('session-name title gates', () => {
  it('the node-title poll is gated on the READ capability', () => {
    // The effect that adopts the agent's own session name into data.title.
    expect(terminalNode).toContain('const canReadTitleNode = !!agentId && canReadTitle(agentId)')
    expect(terminalNode).toContain('if (!canReadTitleNode || data.titleAuto === false) return')
    // The pre-split gate must be gone from that effect — with it, a gemini node never polls.
    expect(terminalNode).not.toContain('if (!canRenameNode || data.titleAuto === false) return')
  })

  it('the `/rename` push is gated on the WRITE capability', () => {
    const pushes = terminalNode
      .split('\n')
      .filter((l) => l.includes('/rename ') && l.includes('sendText'))
    expect(pushes.length).toBe(1)
    expect(pushes[0]).toContain('canRenameNode')
  })

  it('no rename-WRITE site gates on the read capability', () => {
    // These three files hold every push of a node title into a live session (the node header /
    // ✦ AI-name funnel, the canvas-control `rename` verb, `renameSession`, and the pane-probing
    // helper they all use). None of them may ever consult the READ list: an agent that names its
    // own sessions does not necessarily accept a rename.
    // TerminalNode's own push is covered by the test above (it holds both gates, so a
    // whole-file scan would say nothing); these are the files that hold ONLY write paths.
    for (const [name, src] of [
      ['Canvas.tsx', canvas],
      ['lib/sessionRename.ts', sessionRename]
    ] as const) {
      expect(src.includes('canReadTitle'), name).toBe(false)
    }
  })

  it('every canvas rename push sits behind a canRename guard', () => {
    const lines = canvas.split('\n')
    const calls = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('pushSessionRename('))
    expect(calls.length).toBeGreaterThan(0)
    for (const [line, i] of calls) {
      // The guard is an `if (agentId && canRename(agentId) && …)` a few lines above the call.
      const window = lines.slice(Math.max(0, i - 8), i + 1).join('\n')
      expect(window.includes('canRename('), `${i + 1}: ${line.trim()}`).toBe(true)
    }
  })
})
