// scripts/chat-sdk-spike.mjs
// Spike: verify @anthropic-ai/claude-agent-sdk works when spawned from the Electron
// binary in node mode (same runtime as our main process). Run:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/chat-sdk-spike.mjs
// Success = token deltas print live, then a result line with cost/usage.
//
// ── SPIKE RESULT (Task 1 — Task 5 copies this verbatim) ──────────────────────
// PASS with NO env/executable overrides needed.
//   query() streamed from the Electron-as-node runtime out of the box:
//   [init] with session id + 127 slash commands, live text_delta tokens, then a
//   [result] success line with cost/usage.
// Notes for Task 5 (ChatDriver in main):
//   - ELECTRON_RUN_AS_NODE=1 was present in the PARENT env and inherited by the
//     SDK's spawned CLI subprocess; the SDK still worked correctly. No need to
//     strip it from the child env, and no `env` sanitization was required.
//   - No `pathToClaudeCodeExecutable` override needed — the SDK found/spawned its
//     bundled CLI on its own. (If a future runtime can't resolve it, the fallback
//     is `options.pathToClaudeCodeExecutable = <result of \`which claude\`>`.)
//   - Runs under `app.isPackaged === false` dev too; the production main process
//     is the same Electron-node runtime, so the same call site applies.
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '@anthropic-ai/claude-agent-sdk'

async function* prompts() {
  yield {
    type: 'user',
    message: { role: 'user', content: 'Reply with a two-sentence joke about terminals.' }
  }
  // Keep the iterable open briefly so the turn can finish, then end it.
  await new Promise((r) => setTimeout(r, 60_000))
}

const q = query({
  prompt: prompts(),
  options: {
    cwd: process.cwd(),
    includePartialMessages: true,
    permissionMode: 'default',
    allowedTools: [] // pure-text turn; no permissions should fire
  }
})

for await (const msg of q) {
  if (msg.type === 'stream_event') {
    const delta = msg.event?.delta
    if (delta?.type === 'text_delta') process.stdout.write(delta.text)
  } else if (msg.type === 'system' && msg.subtype === 'init') {
    console.log('[init] session', msg.session_id, 'slash:', (msg.slash_commands ?? []).length)
  } else if (msg.type === 'result') {
    console.log('\n[result]', msg.subtype, 'cost=', msg.total_cost_usd, 'usage=', msg.usage)
    break
  }
}
process.exit(0)
