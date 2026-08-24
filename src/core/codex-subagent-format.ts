// Formats a codex subagent's rollout into the activity-log text streamed to its fan-out card —
// the codex counterpart of subagent-tail's claude `formatSubagentChunk`, fed to the tail via
// `trackFile`'s per-entry formatter. Every shape here was measured live on codex-cli 0.146.0
// (spawn_agent single, parallel and nested captures — see PR #401 discussion).
//
// The formatter is STATEFUL, one instance per tracked subagent: a spawn_agent child is a FORK of
// the parent thread (`fork_turns: "all"`), so its rollout OPENS with a replay of the parent's
// context — the parent's session_meta, prior messages, even the parent's own commentary lines.
// Streaming that replay would fill the card with the parent's words before the child has done
// anything. The child's real work begins at the task delivery, marked by an
// `inter_agent_communication_metadata` line ({"trigger_turn":true}) immediately followed by the
// NEW_TASK `response_item/agent_message` — everything before whichever of those appears first is
// suppressed. If neither ever appears (an unforked spawn mode we have not observed), the card
// shows no activity rather than the wrong session's: same degrade-to-nothing rule as the meters.
//
// The task text itself is NOT available: spawn_agent's `message` is encrypted end-to-end (a
// Fernet blob in the tool_input AND in the NEW_TASK payload's `encrypted_content`). The readable
// part is the NEW_TASK header ("Message Type: … Task name: /root/agent_b/nested_echo …"), which
// is collapsed to a `Task: <name>` line.

interface RolloutLine {
  type?: string
  payload?: {
    type?: string
    // event_msg/agent_message
    message?: string
    // event_msg/sub_agent_activity
    kind?: string
    agent_path?: string
    // response_item/agent_message | custom_tool_call_output
    content?: unknown
    output?: unknown
    // response_item/function_call | custom_tool_call
    name?: string
    arguments?: string
    input?: unknown
  }
}

function textItems(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('')
}

function snippet(s: string, max = 80): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

// One-line result summary, same look as claude's subagent activity log.
function summarize(raw: string): string {
  const r = raw.trim()
  if (!r) return ''
  const lines = r.split('\n')
  const first = (lines.find((l) => l.trim()) ?? '').trim().slice(0, 100)
  const extra = lines.length > 1 ? ` … (+${lines.length - 1} lines)` : ''
  return `  ↳ ${first}${extra}`
}

// `arguments` is a JSON string. Prefer the one human-relevant field over dumping the object —
// for spawn_agent that is task_name (`message` is an encrypted blob, never show it).
function argSummary(args: string | undefined): string {
  if (!args) return ''
  try {
    const a = JSON.parse(args) as Record<string, unknown>
    if (typeof a.task_name === 'string') return a.task_name
    if (typeof a.command === 'string') return snippet(a.command)
    const entries = Object.entries(a).filter(([, v]) => typeof v !== 'string' || (v as string).length <= 120)
    if (!entries.length) return ''
    return snippet(entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' '))
  } catch {
    return snippet(args)
  }
}

export function createCodexSubagentFormatter(): (text: string) => string {
  // False until the fork-replay prefix has passed (see header comment).
  let live = false

  const formatLine = (line: string): string => {
    let o: RolloutLine
    try {
      o = JSON.parse(line)
    } catch {
      return ''
    }
    const p = o.payload ?? {}
    if (o.type === 'inter_agent_communication_metadata') {
      live = true
      return ''
    }
    // Inter-agent traffic (NEW_TASK delivery and siblings). Its arrival also ends the replay:
    // in the captures it lands right after the metadata line, but gate on it independently so a
    // rollout that skips the metadata still starts streaming here.
    if (o.type === 'response_item' && p.type === 'agent_message') {
      live = true
      const text = textItems(p.content)
      const task = /Task name:\s*(\S+)/.exec(text)
      if (task) return `Task: ${task[1]}`
      return text.trim()
    }
    if (!live) return ''
    if (o.type === 'event_msg') {
      // The child's own prose (commentary + final answer). The replayed parent prose upstream of
      // the gate never reaches here.
      if (p.type === 'agent_message') return (p.message ?? '').trim()
      // A NESTED spawn observed from this child — one line, the nested card carries the rest.
      if (p.type === 'sub_agent_activity' && p.kind === 'started' && p.agent_path) {
        return `↪ spawned ${p.agent_path}`
      }
      return ''
    }
    if (o.type === 'response_item') {
      if (p.type === 'function_call' && p.name) {
        const arg = argSummary(p.arguments)
        return `$ ${p.name}${arg ? ` ${arg}` : ''}`
      }
      if (p.type === 'custom_tool_call' && p.name) {
        const arg = typeof p.input === 'string' ? snippet(p.input) : ''
        return `$ ${p.name}${arg ? ` ${arg}` : ''}`
      }
      if (p.type === 'custom_tool_call_output') return summarize(textItems(p.output))
      if (p.type === 'function_call_output') {
        return summarize(typeof p.output === 'string' ? p.output : '')
      }
      return ''
    }
    return ''
  }

  return (text: string): string =>
    text.split('\n').filter(Boolean).map(formatLine).filter(Boolean).join('\n')
}
