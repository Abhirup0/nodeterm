// The hook events each agent's managed installer subscribes to — ONE list per agent, shared by
// every installer (local desktop, Server Edition, and the SSH remote installer).
//
// They used to be declared twice, and the copies had drifted: the remote installer subscribed
// claude to `SessionStart`/`SubagentStop` but NOT to `StopFailure`/`PermissionRequest` (so a
// remote agent's errored turn stuck on "working" and its permission prompts arrived late), and it
// subscribed gemini to CLAUDE's event names, which gemini never fires — remote gemini nodes
// reported no status at all.
//
// The drift also produced a broken settings.json on any machine where two installers ran: each
// rewrites only the events IT knows, so a stale instance's command survived on every event the
// other list lacked. Keeping the lists here is what makes an install a complete rewrite.

/** Claude Code hook events. Each maps to a `NormalizedAgentEvent` in shared/agents/normalize.ts. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  // Fires INSTEAD of Stop when the turn ends on an API/model error — without it the
  // status badge sticks on "working" after any errored turn.
  'StopFailure',
  'Notification',
  // Dedicated permission-prompt signal (→ blocked), more direct than Notification.
  'PermissionRequest',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse'
] as const

/** Gemini CLI hook events — its own names, NOT Claude's (see normalizeGemini). */
export const GEMINI_HOOK_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool'] as const
