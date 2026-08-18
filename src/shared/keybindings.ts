/**
 * The keybinding registry + engine, shared by main, renderer, and the Server Edition bridge.
 * Registry, validation, effective-binding resolution, conflict detection, override
 * sanitization, and the pure event→command resolver all live in this one module so the
 * dispatchers, Settings UI, and ShortcutsPanel cannot drift apart. Builds on shortcut.ts —
 * canonical binding strings are shortcut.ts strings (`Cmd` = abstract primary modifier,
 * `Ctrl` = literal Control, modifier-only chords = hold-to-talk).
 */
import { parseShortcut, serializeShortcut, resolvedModifiers } from './shortcut'
import type { ParsedShortcut, ShortcutKeyEvent } from './shortcut'

export type CommandScope = 'app' | 'canvas' | 'terminal' | 'scm'
export type CommandGroup = 'General' | 'Canvas' | 'Nodes' | 'Terminal' | 'Source Control' | 'Speech'

export interface CommandDefinition {
  id: CommandId
  /** English row label for ShortcutsPanel and the Settings section. */
  title: string
  group: CommandGroup
  scope: CommandScope
  /** Canonical shortcut.ts strings. `other` covers linux + win32 — widen to three buckets
   *  only when a real default needs to differ between them. Empty array = unassigned. */
  defaultBindings: { darwin: readonly string[]; other: readonly string[] }
  /** May fire while a real input/textarea/contentEditable is focused (xterm excluded). */
  allowWhileTyping?: boolean
  /** May fire while an xterm has focus. Scope 'terminal' implies it. */
  allowInTerminal?: boolean
  /** Permits modifier-less bindings, restricted to SAFE_BARE_KEYS. */
  allowBareKey?: boolean
  /** Permits modifier-only hold chords (hold-to-talk). */
  allowHoldChord?: boolean
}

export type CommandId =
  | 'app.commandPalette'
  | 'app.settings'
  | 'app.shortcutsPanel'
  | 'view.kanbanToggle'
  | 'panel.explorer'
  | 'panel.sourceControl'
  | 'panel.sessions'
  | 'canvas.undo'
  | 'canvas.redo'
  | 'canvas.deleteSelection'
  | 'canvas.fitAll'
  | 'canvas.groupSelection'
  | 'node.newTerminal'
  | 'node.newAgent'
  | 'node.close'
  | 'node.toggleMarkdown'
  | 'terminal.find'
  | 'terminal.copySelection'
  | 'scm.commit'
  | 'speech.dictation'

/** Same defaults on every platform. */
const both = (...bindings: string[]): { darwin: string[]; other: string[] } => ({
  darwin: bindings,
  other: [...bindings]
})

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  // General — the Canvas.tsx:4491 block today; fires while an xterm has focus, and (bug,
  // fixed in the dispatch PR) also while typing. allowWhileTyping is deliberately absent.
  { id: 'app.commandPalette', title: 'Command palette', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+K'), allowInTerminal: true },
  { id: 'app.settings', title: 'Open settings', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+Comma'), allowInTerminal: true },
  { id: 'app.shortcutsPanel', title: 'Keyboard shortcuts panel', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+Slash'), allowInTerminal: true },
  { id: 'view.kanbanToggle', title: 'Toggle kanban board', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+Shift+B'), allowInTerminal: true },
  { id: 'panel.explorer', title: 'Toggle explorer panel', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+Shift+E'), allowInTerminal: true },
  { id: 'panel.sourceControl', title: 'Toggle source control panel', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+Shift+G'), allowInTerminal: true },
  { id: 'panel.sessions', title: 'Pin sessions sidebar', group: 'General', scope: 'app',
    defaultBindings: both('Cmd+Shift+L'), allowInTerminal: true },

  // Canvas — inert while the kanban board is open (scope 'canvas'), blocked while typing.
  { id: 'canvas.undo', title: 'Undo', group: 'Canvas', scope: 'canvas',
    defaultBindings: both('Cmd+Z') },
  { id: 'canvas.redo', title: 'Redo', group: 'Canvas', scope: 'canvas',
    defaultBindings: { darwin: ['Cmd+Shift+Z'], other: ['Cmd+Shift+Z', 'Cmd+Y'] } },
  { id: 'canvas.deleteSelection', title: 'Delete selection', group: 'Canvas', scope: 'canvas',
    // Mirrors the current platform-blind handler; the typing guard keeps Backspace safe.
    defaultBindings: both('Delete', 'Backspace'),
    allowBareKey: true },
  { id: 'canvas.fitAll', title: 'Fit all nodes in view', group: 'Canvas', scope: 'canvas',
    defaultBindings: both() },
  { id: 'canvas.groupSelection', title: 'Group selection', group: 'Canvas', scope: 'canvas',
    defaultBindings: both() },

  // Nodes
  { id: 'node.newTerminal', title: 'New terminal node', group: 'Nodes', scope: 'canvas',
    defaultBindings: both('Cmd+T') },
  { id: 'node.newAgent', title: 'New agent node', group: 'Nodes', scope: 'canvas',
    // Non-mac note: Ctrl+Shift+C is a common terminal-copy convention; kept for parity
    // with current behavior, revisit with telemetry.
    defaultBindings: both('Cmd+Shift+C') },
  // Main-process intercepted today (unconditional): keep firing everywhere.
  { id: 'node.close', title: 'Close node / window', group: 'Nodes', scope: 'app',
    defaultBindings: both('Cmd+W'), allowInTerminal: true, allowWhileTyping: true },
  { id: 'node.toggleMarkdown', title: 'Toggle markdown view', group: 'Nodes', scope: 'app',
    defaultBindings: both('Cmd+M'), allowInTerminal: true, allowWhileTyping: true },

  // Terminal
  { id: 'terminal.find', title: 'Find in terminal', group: 'Terminal', scope: 'terminal',
    defaultBindings: both('Cmd+F') },
  { id: 'terminal.copySelection', title: 'Copy terminal selection', group: 'Terminal',
    scope: 'terminal',
    // Plain Ctrl+C stays SIGINT off-mac; Cmd+Shift+C resolves to Ctrl+Shift+C there.
    defaultBindings: { darwin: ['Cmd+C'], other: ['Cmd+Shift+C', 'Ctrl+Insert'] } },

  // Source control (local handler; registry supplies label + remap)
  { id: 'scm.commit', title: 'Commit', group: 'Source Control', scope: 'scm',
    defaultBindings: both('Cmd+Enter'), allowWhileTyping: true },

  // Speech — the migrated dictation chord; hold-to-talk by default.
  { id: 'speech.dictation', title: 'Dictate', group: 'Speech', scope: 'app',
    defaultBindings: both('Cmd+Alt'),
    allowHoldChord: true, allowInTerminal: true, allowWhileTyping: true }
]

export const COMMANDS_BY_ID: ReadonlyMap<CommandId, CommandDefinition> = new Map(
  COMMAND_DEFINITIONS.map((d) => [d.id, d])
)

export function isCommandId(v: string): v is CommandId {
  return COMMANDS_BY_ID.has(v as CommandId)
}

/** Modifier-less keys that are safe to bind bare — they don't type a character. */
export const SAFE_BARE_KEYS: ReadonlySet<string> = new Set([
  'DELETE', 'BACKSPACE', 'ESCAPE', 'ENTER', 'TAB',
  'ARROWUP', 'ARROWDOWN', 'ARROWLEFT', 'ARROWRIGHT', 'PAGEUP', 'PAGEDOWN',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
])

export type NormalizedBinding = { ok: true; value: string } | { ok: false; error: string }

/** Parse + validate one binding string against a command's flags; returns the canonical
 *  serialized form on success. The single validation path for defaults (pinned by a registry
 *  test), Settings-recorder captures, and hand-edited settings.json overrides. */
export function normalizeBindingForCommand(
  def: CommandDefinition,
  raw: string,
  isMac: boolean
): NormalizedBinding {
  const p = parseShortcut(raw)
  const hasAnyToken = p.cmd || p.ctrl || p.alt || p.shift || p.key !== null
  if (!hasAnyToken) return { ok: false, error: 'Use a shortcut like Cmd+K or Cmd+Shift+P.' }
  if (!isMac && p.cmd && p.ctrl) {
    return { ok: false, error: 'Cmd already means Ctrl on this platform; use one of them.' }
  }
  if (p.key === null) {
    if (!def.allowHoldChord) {
      return { ok: false, error: 'This command needs a key, not a modifier-only chord.' }
    }
    if (!p.cmd && !p.ctrl && !p.alt) {
      return { ok: false, error: 'A hold chord needs at least one non-shift modifier.' }
    }
    return { ok: true, value: serializeShortcut(p) }
  }
  const hasStrongModifier = p.cmd || p.ctrl || p.alt
  if (!hasStrongModifier) {
    if (p.shift) return { ok: false, error: 'Shift-only shortcuts would steal typed text.' }
    if (!def.allowBareKey || !SAFE_BARE_KEYS.has(p.key)) {
      return { ok: false, error: 'Include a modifier key.' }
    }
  }
  return { ok: true, value: serializeShortcut(p) }
}
