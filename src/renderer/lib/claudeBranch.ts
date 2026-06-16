// Drives Claude Code's own `/branch` slash command from a node action.
//
// Running `/branch` switches the CURRENT terminal onto a new branch and prints, e.g.:
//   Branched conversation. You are now in the new branch (session <NEW_ID>). Use
//   /resume <ORIGINAL_ID> to return to the original, or run claude -r <ORIGINAL_ID> in a
//   new terminal.
// We parse <ORIGINAL_ID> so the caller can open a second node that resumes the parked
// original conversation (`claude -r <ORIGINAL_ID>`).

const ORIGINAL = /claude -r\s+([0-9a-fA-F-]{8,})/
const RESUME = /\/resume\s+([0-9a-fA-F-]{8,})/

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface BranchResult {
  ok: boolean
  originalId?: string
  error?: string
}

export async function branchClaudeSession(nodeId: string): Promise<BranchResult> {
  const sent = await window.nodeTerminal.pty.sendText(nodeId, '/branch')
  if (!sent) return { ok: false, error: 'Branch requires a persistent (tmux) session.' }

  // Poll the visible buffer until the branch output (with the original session id) appears.
  for (let i = 0; i < 20; i++) {
    await delay(300)
    const buf = await window.nodeTerminal.pty.capture(nodeId)
    const m = buf.match(ORIGINAL) ?? buf.match(RESUME)
    if (m) return { ok: true, originalId: m[1] }
  }
  return { ok: false, error: "Couldn't detect the branch result — open a Claude node manually if needed." }
}
