// Context Link — lets two Claude nodes on the canvas read each other's context on demand.
//
// Connecting two Claude nodes means "these two may READ each other." No messages flow. The
// renderer pushes the current link map to main (context-link:set-links); main writes one
// enriched file per node to <userData>/context-links/<nodeId>.json (linked nodes' titles,
// transcript paths learned from hooks, cwds, tmux session names). A self-contained CLI
// (context-cli.mjs, run via Electron-as-Node through context.sh) reads that file and prints
// the linked node's transcript / summary / terminal output. A globally-installed Claude
// skill tells the agent how + when to call it.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ContextLinkMap } from '../shared/types'
import { type PtyManager } from './pty-manager'
import { TMUX_SOCKET } from './tmux-naming'
import { CLI_SCRIPT, buildLinkDoc, transcriptPathOf } from './context-link-core'

export { setNodeTranscript } from './context-link-core'

let dir = ''
export function contextLinkDir(): string {
  if (!dir) dir = path.join(app.getPath('userData'), 'context-links')
  return dir
}
function cliScriptPath(): string {
  return path.join(contextLinkDir(), 'context-cli.mjs')
}
function cliShimPath(): string {
  return path.join(contextLinkDir(), 'context.sh')
}
function skillPath(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'get-linked-context', 'SKILL.md')
}

function writeCliFiles(): void {
  const d = contextLinkDir()
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(cliScriptPath(), CLI_SCRIPT)
  const shim = `#!/bin/sh
# nodeterm context-link CLI shim (auto-generated — do not edit).
ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cliScriptPath()}" "$@"
`
  fs.writeFileSync(cliShimPath(), shim)
  try {
    fs.chmodSync(cliShimPath(), 0o755)
  } catch {
    /* fail open */
  }
}

function installSkill(): void {
  const body = `---
name: get-linked-context
description: Read the conversation/transcript, a recent summary, or the terminal output of another Claude node you are linked to on the nodeterm canvas. Use when you need to know what a connected node has been doing, hand off, or continue its work. Only meaningful inside a nodeterm session with a context-link edge.
---

# Get linked context

On the nodeterm canvas, this Claude session may be connected to other Claude nodes by a
context-link edge. When you are linked, you can READ the other node's context on demand by
running the local CLI shim below. Nothing is pushed to you automatically — pull what you need.

Run the shim (absolute path):

\`\`\`sh
sh "${cliShimPath()}" <command> [--node <id|title>] [-n <N>]
\`\`\`

Commands:
- \`list\` — list the nodes you are linked to (start here).
- \`summary [--node X] [-n 15]\` — the last N lines of a linked node's conversation.
- \`transcript [--node X]\` — the linked node's full conversation transcript.
- \`terminal [--node X]\` — the linked node's recent terminal output (visible buffer).

\`--node\` is optional when you are linked to exactly one node; otherwise pass the id or title
from \`list\`. If the CLI says "Not a nodeterm session" or "No linked nodes", there is nothing
to read — do not retry.
`
  try {
    fs.mkdirSync(path.dirname(skillPath()), { recursive: true })
    fs.writeFileSync(skillPath(), body, 'utf8')
  } catch (e) {
    console.warn('[context-link] skill install failed', e)
  }
}

let pty: PtyManager | undefined

// Write one enriched link file per node id present in the map. Removed links should not
// linger, so we clear stale per-node files first.
function writeLinkFiles(map: ContextLinkMap): void {
  const d = contextLinkDir()
  const bin = pty?.getTmuxBin() ?? null
  try {
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.json')) fs.rmSync(path.join(d, f), { force: true })
    }
  } catch {
    /* dir may not exist yet */
  }
  for (const [nodeId, links] of Object.entries(map)) {
    const doc = buildLinkDoc(nodeId, links, {
      transcriptOf: transcriptPathOf,
      tmuxBin: bin,
      tmuxSocket: TMUX_SOCKET
    })
    try {
      fs.writeFileSync(path.join(d, `${nodeId}.json`), JSON.stringify(doc, null, 2))
    } catch (e) {
      console.warn('[context-link] write link file failed', e)
    }
  }
}

export function initContextLink(win: BrowserWindow, ptyManager: PtyManager): void {
  pty = ptyManager
  try {
    const d = contextLinkDir()
    fs.mkdirSync(d, { recursive: true })
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.json')) fs.rmSync(path.join(d, f), { force: true })
    }
    writeCliFiles()
    installSkill()
  } catch (e) {
    console.error('[context-link] setup failed', e)
    return
  }
  ipcMain.handle(IPC.contextLinkSetLinks, (_e, map: ContextLinkMap) => {
    writeLinkFiles(map && typeof map === 'object' ? map : {})
  })
  // win is reserved for future link-activity events; referenced to satisfy noUnusedParameters.
  void win
}
