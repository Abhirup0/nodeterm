/**
 * Reflect the active session in the native window title (issue #414).
 *
 * Window-title-based time trackers (ActivityWatch is the reporter's) read whatever title the OS
 * shows for the focused window — that is how they tell "which iTerm2 tab / VS Code file" apart.
 * nodeterm keeps everything inside ONE OS window, so those tools only ever saw the static app
 * title. With `settings.windowTitleActiveSession` on, the title becomes
 * `<node title> — <project name> — <base title>` for whichever node was last active.
 *
 * The write is `document.title`, deliberately, on both surfaces: Electron mirrors page-title
 * changes onto the BrowserWindow (nothing in `src/main` intercepts `page-title-updated`), and in
 * the Server Edition the same write titles the browser tab. No IPC, no bridge member to stub.
 *
 * "Active node" is fed by two signals, latest-wins, both wired in Canvas:
 *  - focus: `installActiveNodeTracker` reports the canvas node whose DOM subtree gained keyboard
 *    focus (an xterm textarea, a sticky's editor, Monaco). Focus landing OUTSIDE any node (tab
 *    bar, Settings, palette) deliberately reports nothing — for a time tracker, "the session I
 *    was last in" is the honest answer while the user pokes at chrome around it.
 *  - selection: Canvas reports a single-node selection (clicking a node header moves no focus).
 *
 * A node id that stops resolving (deleted node, project switch) degrades to the project name, and
 * the OFF state — or nothing to show — restores the exact title the page booted with, captured
 * before the first write ever happens, so the feature disabled is byte-identical to before it
 * existed (including the NT_MULTI "(test instance)" label in dev sandboxes).
 */

/** Title separator — the em-dash convention window titles already use (VS Code, iTerm2). */
const SEP = ' — '

export interface WindowTitleParts {
  enabled: boolean
  /** What the title falls back to (and suffixes) — the page's boot title. */
  baseTitle: string
  nodeTitle?: string | null
  projectName?: string | null
}

/** Compose the full window title. Pure — the applier owns the DOM. Empty/whitespace parts drop
 *  out, and a node titled exactly like its project is shown once, not twice. */
export function composeWindowTitle({
  enabled,
  baseTitle,
  nodeTitle,
  projectName
}: WindowTitleParts): string {
  if (!enabled) return baseTitle
  const parts: string[] = []
  for (const raw of [nodeTitle, projectName]) {
    const p = raw?.trim()
    if (p && !parts.includes(p)) parts.push(p)
  }
  if (parts.length === 0) return baseTitle
  return [...parts, baseTitle].join(SEP)
}

/** The canvas node id owning `el`, via React Flow's node wrapper (`.react-flow__node[data-id]`),
 *  or null when focus landed outside every node. */
export function nodeIdForFocusTarget(el: unknown): string | null {
  if (!(el instanceof Element)) return null
  const wrapper = el.closest('.react-flow__node[data-id]')
  return wrapper?.getAttribute('data-id') ?? null
}

export interface ActiveNodeTrackerOptions {
  /** Called with the node id whenever keyboard focus lands inside a canvas node. Never called
   *  for focus outside the canvas — the last active node deliberately stands. */
  report: (nodeId: string) => void
}

/** Start reporting focus-derived active nodes. Returns the teardown. */
export function installActiveNodeTracker(opts: ActiveNodeTrackerOptions): () => void {
  const onFocusIn = (e: FocusEvent): void => {
    const id = nodeIdForFocusTarget(e.target)
    if (id) opts.report(id)
  }
  window.addEventListener('focusin', onFocusIn)
  return () => window.removeEventListener('focusin', onFocusIn)
}

/** The page's boot title, captured once BEFORE the first write — the restore target for the OFF
 *  state. Lazy (not at import) so a test's jsdom title churn cannot poison it. */
let baseTitle: string | null = null

export function windowBaseTitle(): string {
  if (baseTitle === null) baseTitle = document.title
  return baseTitle
}

/** Test-only: forget the captured base title so each test's jsdom starts clean. */
export function resetWindowBaseTitleForTest(): void {
  baseTitle = null
}

/** Write the title if it changed. Change-deduped: Electron forwards every page-title update over
 *  IPC to the BrowserWindow, so re-assigning the same string per render is pure noise. */
export function applyWindowTitle(next: string): void {
  if (document.title !== next) document.title = next
}
