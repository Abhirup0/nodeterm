# Notch HUD (macOS) — contract

Agent-notch's UX, native to nodeterm: a transparent always-on-top strip along the top edge that
shows **walking agent mascots beside the MacBook notch** while agents work, and expands on click
into a **mini session panel**. macOS-only, desktop-only. Fed by nodeterm's own hook-based
agent-status (precise working/done — no ~30 s afterglow), reusing nodeterm's existing mascot art.
Owner decisions: hook-fed; its own mini panel with a "Go" button that opens the node in nodeterm;
**default ON** (guarded to darwin; toggleable in Settings).

## Window (src/main/notch-hud.ts, new)

One BrowserWindow: `{frame:false, transparent:true, hasShadow:false, resizable:false,
alwaysOnTop:true, focusable:false, skipTaskbar:true}` + `setAlwaysOnTop(true,'screen-saver')` +
`setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` + `setIgnoreMouseEvents(true,
{forward:true})`. Its own renderer entry `hud.html` (add to electron.vite.config.ts
`renderer.input`) sharing the existing preload plus a small HUD-specific API.

- **Geometry** from `screen.getPrimaryDisplay()`: strip at `bounds.y`, full `bounds.width`, height
  = notch bar height (`workArea.y - bounds.y`, floor 24). The notch is centered at `bounds.width/2`;
  Electron exposes no `auxiliaryTopLeftArea`, so assume a centered notch and place the mascot slot
  just LEFT of center (fake notch width ~200 px when `workArea.y === bounds.y`, i.e. no physical
  notch → center on a virtual pill). Re-assert on `screen` `display-metrics-changed` +
  `display-added/removed`.
- **Click-through with a hotspot**: window stays mouse-ignoring; the renderer reports pointer
  enter/leave of the indicator rect over IPC → main toggles `setIgnoreMouseEvents(false/true,
  {forward:true})`. Click in the hotspot → expand; click outside the expanded panel → collapse
  (a `blur`/global-ish check — simplest: an app-level click-away by tracking pointer-leave of the
  expanded bounds). Never animate the window frame — size it to the expanded box, drive a CSS
  `transform: scale()` from `transform-origin: top center` (≈0.25×0.06 → 1, 200 ms ease) + opacity
  for expand/collapse.

## Data (main-side controller, no core changes)

Subscribe to the SAME seams push-notify uses (`agent-status-mirror.ts`): `onNodeStateChange`
(working/needsYou/done edges), `onNodeNowChange` (activity + context%), `onMirrorFlush` (full
table). Join per node: `workspaceStore.getNodeTitle(nodeId)` (title), `IPC.contextUpdate` (model,
by sessionId), and a controller-local `Map<nodeId,lastPrompt>` fed from `emitAgentStatus`'s
`ev.task` on `newTurn` (no core change), plus a `Map<nodeId,Set<toolUseId>>` for subagents off the
subagent-start/end events (main already keeps `nodeSubagents`). Push a debounced snapshot array to
the HUD window via a `getHudWindow()`/`sendToHud()` singleton (mirror `main-window.ts`).

Row shape sent to the HUD:
```ts
{ nodeId, agentId, title, model?, state: 'working'|'needsYou'|'done'|'idle',
  prompt?, activity?, contextPercent?,
  subagents: [{ id, label?, state: 'working'|'done' }] }
```
- **done latch + clear**: `done` state is latched by the mirror already; clear a node's done
  highlight when the user focuses that node in nodeterm (reuse `app:focus-node`) OR after the HUD
  panel is opened — a nodeterm-native "you looked at it" signal (better than agent-notch's
  terminal-bundle-id sniff). Drop a node from the HUD when it's gone + idle > 6 h.

## Indicator + panel (hud renderer)

Reuse `src/renderer/lib/mascot.ts` (`CLAUDE_MASCOT` data-URI + `CODEX_MASCOT` geometry +
`pet-codex.webp`) and the walk-cycle CSS from AgentMascot/styles.css — plain DOM, no React
coupling needed (React optional; keep the HUD lean). Master clock 120 ms.
- **Indicator (collapsed)**: right-aligned toward the notch — a slot per agent kind that has a
  working/done node: claude → 2-frame coral pixel mascot walking (2.5 fps); codex → the pet
  spritesheet first-row crop (8 frames, 120 ms, `image-rendering: pixelated`); a shimmering green
  blob for a done-unseen slot. Nothing shown when all idle.
- **Panel (expanded)**: up to ~6 session rows, newest-active first. Each row: animated mascot/green
  check + title + `model · reltime` tag (blue working / gray idle / green done) + a `You: <prompt>`
  (or `activity`) second line + a `▸ N subagents` disclosure (child rows: label + state). A **Go**
  button (or row-tap) → IPC → main mirrors the notification-click handler:
  `getMainWindow().show()/focus()` + `sendToMain(app:focus-node, nodeId)` → `Canvas.focusNodeById`,
  and clears that node's done latch.

## Settings + lifecycle

New `settings.notchHud` (default **true**). `initNotchHud(win)` from `index.ts`, guarded
`process.platform === 'darwin'` and the setting; toggling the setting creates/destroys the HUD
window live. Three-surfaces: desktop/macOS-only — `src/server` and iOS untouched (pure reader of
existing main state; the no-electron tests stay green because all new code is in `src/main` + a
renderer entry).

## Out of scope (v1)

Pet-switching config, non-darwin (Windows/Linux) HUD, per-row context menu, multi-monitor notch
precision beyond centering, the SDK chat node in the panel.
