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
function skillPath(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
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

function installSkill(): void {
  const body = `---
name: manage-nodeterm-canvas
description: Open and control nodes on the nodeterm canvas — spawn Claude/terminal sessions, show an image/video/web page, write to or close a terminal. Use when the user asks you to open sessions, visualize something, or render the code/output you produced on the canvas. Only works inside a nodeterm Claude session.
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
- \`write --node <id> --text "..."\` — type text into a terminal node. (Asks the user to confirm.)
- \`close --node <id>\` — close a node. (Asks the user to confirm.)

Notes:
- \`write\` and \`close\` require the user to approve a confirmation dialog; they may be denied.
- If the CLI says canvas control is unavailable, you are not in a controllable nodeterm session — do not retry.

To orchestrate a team: decide the roles + a concrete starting prompt for each, then one
\`spawn-team\` call (or \`open-claude\` per role followed by \`group\` + \`arrange\`).
`
  try {
    fs.mkdirSync(path.dirname(skillPath()), { recursive: true })
    fs.writeFileSync(skillPath(), body, 'utf8')
  } catch (e) {
    console.warn('[canvas-control] skill install failed', e)
  }
}

export function initCanvasControl(): void {
  try {
    writeCliFiles()
    installSkill()
  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
