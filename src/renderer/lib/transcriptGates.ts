import { canChat, type AgentId } from '@shared/agents/config'

/**
 * Does this node's conversation live in a file **claude's** transcript readers can locate and parse?
 *
 * This is the gate for every feature that goes through `core/transcript-ipc.ts`'s
 * `resolveTranscript` — today `context.ensure` (the context meter's mount-time rehydration) and the
 * find bar's transcript index (`claude.readTranscript`). It is deliberately NOT `hasUsage`.
 *
 * Those two used to share `hasUsage` with the context METER, back when all three were claude-only
 * and the distinction cost nothing. Then codex and gemini joined `USAGE_CAPABLE` (their own
 * transcripts state the numbers a meter needs) and the shared gate turned into a bug in both
 * features at once, because `resolveTranscript` has a **cwd fallback**: when the sessionId leg
 * misses — which it always does for a codex/gemini id, since no `<that id>.jsonl` exists under
 * `~/.claude/projects` — it returns *the newest claude transcript for that cwd*. So a codex node
 * would rehydrate its meter from a stranger's claude session (wrong numerator AND wrong
 * denominator, then flapping against the correct codex tail) and its find bar would present that
 * session's messages as its own hits. Even wired to the right file the reader would be wrong: it
 * parses claude's JSONL shape, which a codex rollout is not.
 *
 * `CHAT_CAPABLE` already states exactly the fact being asked for — "we can read and render this
 * agent's transcript ourselves" — so it is reused here rather than adding a fourth capability list
 * that would mean the same thing.
 *
 * The meter itself stays on `hasUsage` and spans three agents: it is fed by the per-agent context
 * tails in the shells (`geminiContextParse` / `codexContextParse`), which need no resolver because
 * the hook envelope hands them the path. The only thing a non-claude agent gives up here is the
 * mount-time HEAD START: its meter fills on the first hook event after mount instead of instantly.
 * Correct-but-later beats instant-but-borrowed-from-another-session.
 *
 * FOLLOW-UP (own task): per-agent rehydration. Making `context.ensure` work for codex/gemini means
 * teaching it to resolve THEIR transcripts (`handoff/locate.ts` already has `locateCodex` /
 * `locateGemini` by sessionId) and to route to the matching tail — a real feature, not a gate.
 */
export function readsClaudeTranscript(agentId: AgentId | undefined): boolean {
  return !!agentId && canChat(agentId)
}
