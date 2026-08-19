/**
 * The single window-keydown dispatcher for registry commands plus the registry-less gestures
 * Canvas carries (keyed dictation, Cmd+0 / Shift+1 zoom, Cmd+1-9 project jump, Cmd+C copy). One
 * pass, documented order; an unclaimed chord falls through to the focused surface / PTY — never to
 * another command. Pure so node-env tests can drive it without a DOM; Canvas supplies the live
 * accessors and handler closures.
 *
 * Two contracts this module exists to state, both load-bearing:
 *
 * 1. **Gesture order.** Keyed dictation runs BEFORE the registry (a custom keyed chord may
 *    deliberately collide with a registry default and must keep winning — it predates the
 *    registry), and zoom → projectJump → copy run AFTER a registry miss, in that exact order.
 *    This mirrors today's if-chain ORDERING in Canvas, so consolidation changes no ordering
 *    outcome; the typing-guard delta is separate and deliberate (see the registry's
 *    `allowWhileTyping` flags — app-scope rows lack it, so typing now blocks them too).
 *
 * 2. **Claim protocol.** `preventDefault()` is called ONLY when a handler actually claims the key
 *    (returns true). A command that resolved but whose handler declined — or that has no handler
 *    registered at all — falls through to the PLATFORM (the focused surface, the terminal, the
 *    browser/main-process accelerator), and NEVER to a gesture that could reinterpret the same
 *    chord as something else.
 *
 *    The third fall-through path is the one to watch: a chord BLOCKED by the resolver's context
 *    gates (typing, terminal, kanban) returns null exactly like an unbound chord, so the two are
 *    indistinguishable here and BOTH reach the trailing gestures — Cmd+Z while typing misses the
 *    registry and is offered to zoom → projectJump → copy. Those gestures receive the RAW event
 *    with no context, so **each trailing gesture closure owes its own focus/typing guard**; keyed
 *    dictation is the only gesture this module guards.
 */
import { resolveCommandForKeyEvent, type CommandId, type KeybindingOverrides } from '@shared/keybindings'
import { keyDispatchContextFor, type ContextElement } from './keyContext'

/** Structural key event so node-env tests need no DOM (a real KeyboardEvent satisfies it). */
export interface GlobalKeyEvent {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
  defaultPrevented: boolean
  preventDefault(): void
}

/** A handler returns true when it CLAIMED the key; false leaves the chord to the platform. */
export type CommandHandlers = Partial<Record<CommandId, () => boolean>>

export interface GlobalKeydownDeps {
  activeElement: () => ContextElement | null
  kanbanOpen: () => boolean
  overrides: () => KeybindingOverrides
  isMac: boolean
  handlers: CommandHandlers
  /** Registry-less chords, tried in this exact order (matches today's if-chain order):
   *  keyed dictation BEFORE the registry (a custom keyed chord may collide with a default
   *  and must keep winning), zoom/projectJump/copy AFTER a registry miss. Each returns true
   *  when it claimed the key (and did its own preventDefault where it needs one). */
  gestures: {
    keyedDictation: (e: GlobalKeyEvent) => boolean
    zoom: (e: GlobalKeyEvent) => boolean
    projectJump: (e: GlobalKeyEvent) => boolean
    copy: (e: GlobalKeyEvent) => boolean
  }
}

export function dispatchGlobalKeydown(e: GlobalKeyEvent, deps: GlobalKeydownDeps): boolean {
  // A child handler (find bar, dialogs, terminal) that already claimed the key wins outright.
  if (e.defaultPrevented) return false
  // Task 2 threads the real policy (a deps thunk); app-first until then, which is today's behavior.
  const ctx = keyDispatchContextFor(deps.activeElement(), deps.kanbanOpen(), false)
  // Keyed dictation predates the registry and may deliberately collide with a default; it
  // keeps first claim, but only in plain app focus (its old guard blocked inputs AND xterm).
  if (!ctx.typing && !ctx.terminal && !ctx.kanbanOpen && deps.gestures.keyedDictation(e)) return true
  const id = resolveCommandForKeyEvent(e, ctx, deps.overrides(), deps.isMac)
  if (id) {
    const handler = deps.handlers[id]
    if (handler && handler()) {
      e.preventDefault()
      return true
    }
    // Resolved but unhandled/declined: fall through to the platform, never to a gesture that
    // could reinterpret the same chord.
    return false
  }
  if (deps.gestures.zoom(e)) return true
  if (deps.gestures.projectJump(e)) return true
  if (deps.gestures.copy(e)) return true
  return false
}
