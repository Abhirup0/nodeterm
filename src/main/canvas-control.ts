// Installs the outbound canvas-control CLI + a Claude skill describing it. Mirrors
// context-link.ts: a self-contained CLI (canvas-control-cli.mjs, run via Electron-as-Node
// through nodeterm.sh) POSTs to the hook server's /control/* routes; the skill tells the
// agent how + when to call it. The CLI no-ops unless NODETERM_CANVAS_CONTROL is set.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { CONTROL_CLI_SCRIPT } from './canvas-control-core'

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
description: Create, organize and control nodes on the nodeterm canvas — open Claude Code / Codex / Gemini / terminal nodes, spawn a team of agents that divide up a task, wrap nodes in labeled groups, arrange/align/rename them, show an image/video/web page, write to or close a terminal. Use whenever the user asks to create or open nodes/sessions, build something using multiple Claude (or other agent) sessions, split work across agents, organize the canvas into groups by topic, or visualize code/output you produced. Only works inside a nodeterm Claude session.
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
- \`open-terminal [--cwd P] [--cmd C]\` — open a terminal node.
- \`open-claude [--count N] [--cwd P] [--prompt T]\` — open N Claude sessions (default 1).
- \`open-agent --agent claude|codex|gemini|<custom-id> [--count N] [--cwd P] [--prompt T]\` — open N sessions of any agent CLI.
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

export function initCanvasControl(): void {
  try {
    writeCliFiles()
    installCanvasSkillInto(path.join(os.homedir(), '.claude'))
  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
