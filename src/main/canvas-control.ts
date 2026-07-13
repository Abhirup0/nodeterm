// Installs the outbound canvas-control CLI + per-agent discovery docs. Mirrors
// context-link.ts: a self-contained CLI (canvas-control-cli.mjs, run via Electron-as-Node
// through nodeterm.sh) POSTs to the hook server's /control/* routes; a Claude skill /
// codex-gemini instruction blocks tell the agent how + when to call it. The CLI no-ops
// unless NODETERM_CANVAS_CONTROL is set.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import {
  CONTROL_CLI_SCRIPT,
  buildCanvasControlInstructions,
  mergeCanvasControlBlock
} from './canvas-control-core'

function dir(): string {
  return path.join(app.getPath('userData'), 'canvas-control')
}
function cliScriptPath(): string {
  return path.join(dir(), 'canvas-control-cli.mjs')
}
function shimPath(): string {
  return path.join(dir(), 'nodeterm.sh')
}
function skillPathIn(configDir: string): string {
  return path.join(configDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
}

function writeCliFiles(): void {
  const d = dir()
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(cliScriptPath(), CONTROL_CLI_SCRIPT)
  const shim = `#!/bin/sh
# nodeterm canvas-control CLI shim (auto-generated — do not edit).
ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cliScriptPath()}" "$@"
`
  fs.writeFileSync(shimPath(), shim)
  try {
    fs.chmodSync(shimPath(), 0o755)
  } catch {
    /* fail open */
  }
}

function skillBody(): string {
  return `---
name: manage-nodeterm-canvas
description: Create, organize and control nodes on the nodeterm canvas — open Claude Code / Codex / Gemini / terminal nodes, spawn a team of agents that divide up a task, create git worktrees as bound groups, wrap nodes in labeled groups, arrange/align/rename them, show an image/video/web page, write to or close a terminal. Use whenever the user says "Build with Nodeterm orchestration", asks to create or open nodes/sessions, build something using multiple Claude (or other agent) sessions, split work across agents or worktrees, organize the canvas into groups by topic, or visualize code/output you produced. Only works inside a nodeterm Claude session.
---

# Manage the nodeterm canvas

You are running inside a node on the nodeterm canvas. You can create and control nodes by
running the local CLI shim below. Every node you open is connected to your node by an edge.

Run the shim (absolute path):

\`\`\`sh
sh "${shimPath()}" <verb> [args]
\`\`\`

Verbs:
- \`list\` — list current nodes (id, kind, title). Start here when you need a node id.
- \`open-terminal [--count N] [--cwd P] [--cmd C] [--group <id>]\` — open N plain terminals (default 1).
- \`open-claude [--count N] [--cwd P] [--prompt T] [--group <id>]\` — open N Claude sessions (default 1).
- \`open-agent --agent claude|codex|gemini|<custom-id> [--count N] [--cwd P] [--prompt T] [--group <id>]\` — open N sessions of any agent CLI.
  \`--group\` parents the node(s) into an existing group frame; a worktree-bound group also
  hands its worktree path down as the cwd.
- \`show-image <path>\` — open an image file as a node.
- \`show-video <path>\` — open a video file as a player node.
- \`show-web (--url U | --file P.html | --html "<...>")\` — open a web viewer (live URL or local HTML you wrote).
- \`open-browser --url U\` — open a navigable browser (back/forward/address bar) at a URL.
- \`group --nodes <id,id> [--label "Frontend Team"]\` — wrap nodes in a labeled group frame.
- \`arrange --nodes <id,id> [--layout grid|row|column] [--cols N]\` — tidy layout, no overlap.
- \`align --nodes <id,id> --edge left|right|top|bottom|hcenter|vcenter\` — align edges/centers.
- \`spawn-team --label "Frontend Team" --team '[{"title":"UI","prompt":"...","agent":"claude"}]'\` —
  open one agent per role (each prompt starts that member working), arrange them in a grid,
  wrap them in a labeled group, and connect each to you. Max 8 roles per call.
- \`open-worktree --branch <name> [--base <ref>] [--path P] [--group <id>]\` — create a git
  worktree (new branch off base, default: the repo's default branch) and wrap it in a bound
  group frame (or bind it to an existing empty group). Terminals created inside the group
  run in the worktree. Local projects only.
- \`close-worktree --group <id> [--mode unbind|remove]\` — unbind (default) drops the binding
  and keeps the directory; remove asks the user to confirm deleting the worktree.
- \`branch --node <id>\` — branch a Claude node's conversation: the node stays on the new
  branch and a new node opens resuming the original. Target must be a Claude agent node.
- \`rename --node <id> --title "New Name"\` — rename any node (terminals, groups, stickies…).
- \`write --node <id> --text "..."\` — type text into a terminal node. (Asks the user to confirm.)
- \`close --node <id>\` — close a node. (Asks the user to confirm.)

Notes:
- \`write\` and \`close\` require the user to approve a confirmation dialog; they may be denied.
- If the CLI says canvas control is unavailable, you are not in a controllable nodeterm session — do not retry.

To orchestrate a team: decide the roles + a concrete starting prompt for each, then one
\`spawn-team\` call (or \`open-claude\` per role followed by \`group\` + \`arrange\`).

Typical requests this skill covers:
- "Create Claude Code nodes for X and organize them into groups by subject" → decide the
  workstreams, then either one \`spawn-team\` per subject (each team is already a labeled
  group), or \`open-claude\`/\`open-agent\` per node followed by \`group --nodes ... --label\`
  per subject and \`arrange\` inside each.
- "Open a codex/gemini session" → \`open-agent --agent codex|gemini\`.
- "Tidy up / group my terminals" → \`list\`, then \`group\` + \`arrange\` + \`align\`.
- "Rename this node/group" → \`rename\`.

## Nodeterm orchestration ("Build with Nodeterm orchestration")

When the user says "Build with Nodeterm orchestration" (or asks you to orchestrate a build
across Nodeterm sessions), be the orchestration chef — plan the kitchen, then run it:

1. Break the task into 2–5 independent workstreams (by subsystem, not by file).
2. Per workstream, give it its own branch + kitchen station:
   \`open-worktree --branch <slug>\` → note the returned \`groupId\`, then
   \`open-agent --agent claude --group <groupId> --prompt "<concrete, self-contained task>"\`.
   Each stream now works on its own branch in its own worktree group — no tree conflicts.
3. Keep the kitchen tidy: members opened with \`--group\` land in neat grid slots inside the
   frame automatically (the frame grows to fit), and successive \`open-worktree\` frames fan
   out side by side — after opening all stations, align the frames with
   \`arrange --nodes <groupId,groupId,…> --layout row\` (arrange/align work on top-level
   nodes, so pass the GROUP ids, not the children). \`rename\` each group by subject.
4. Track progress (their status badges show working/waiting) and coordinate: when a stream
   finishes, the user merges from the group's chip (never merge for them); release a finished
   station with \`close-worktree --group <id>\` (unbind keeps the directory).
`
}

/**
 * Install (or refresh) the canvas-control skill into a Claude config dir's `skills/`.
 * Claude Code resolves user skills relative to CLAUDE_CONFIG_DIR, so managed accounts
 * (config dir = {userData}/claude-accounts/<id>) need their own copy — mirroring how the
 * managed status hook is merged into each account dir's settings.json. Best-effort.
 */
export function installCanvasSkillInto(configDir: string): void {
  const p = skillPathIn(configDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, skillBody(), 'utf8')
  } catch (e) {
    console.warn('[canvas-control] skill install failed', p, e)
  }
}

// Codex/Gemini have no skill system — merge the canvas-control block into their global
// instruction files (marker-delimited, idempotent, other content preserved). Same pattern
// as context-link's get-linked-context block. The CLI env-gate keeps the block inert in
// the user's normal (non-nodeterm) codex/gemini sessions.
function installAgentInstructions(): void {
  const block = buildCanvasControlInstructions(shimPath())
  const targets = [
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md')
  ]
  for (const p of targets) {
    try {
      let existing = ''
      try {
        existing = fs.readFileSync(p, 'utf8')
      } catch {
        /* new file */
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, mergeCanvasControlBlock(existing, block), 'utf8')
    } catch (e) {
      console.warn('[canvas-control] instructions install failed', p, e)
    }
  }
}

export function initCanvasControl(): void {
  try {
    writeCliFiles()
    installCanvasSkillInto(path.join(os.homedir(), '.claude'))
    installAgentInstructions()
  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
