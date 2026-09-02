// Renders a grok chat history .jsonl (~/.grok/sessions/<cwd>/<id>/chat_history.jsonl) to full
// Markdown. No size cap, no summarization.
//
// The file is `chat_history.jsonl`, NOT the `updates.jsonl` grok's hook payloads advertise. Being
// precise about the sibling, because an overstatement here would be the same sin this integration
// keeps paying for: `updates.jsonl` DOES carry conversation, as `agent_message_chunk` /
// `user_message_chunk` interleaved with tool-call, hook and compaction events (measured across 29
// sessions). What it does not carry is a settled message per line, so `linesFromGrok` finds no
// `type` on any of them and renders an empty handoff rather than an error. `core/handoff/locate.ts` is where that choice is made and pinned.
//
// Shape knowledge is NOT duplicated here. `linesFromGrok` (core/context-link-render.ts) already
// parses every measured line type from a real session, including the `synthetic_reason` rule that
// keeps harness-injected text from being attributed to the human — a distinction that matters more
// in a handoff than anywhere else, because the receiving agent reads "the user said X" as an
// instruction. This module only turns those lines into Markdown headings.
import { linesFromGrok } from '../../core/context-link-render'

/** `role: text` (and the `  $ `/`  = ` tool lines) as `linesFromGrok` emits them. */
const ROLE_RE = /^(\w+): ([\s\S]*)$/

const HEADINGS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System'
}

export function renderGrokTranscript(raw: string): string {
  const out: string[] = []
  for (const line of linesFromGrok(raw)) {
    // Tool lines are indented continuations of the message above them, never messages of their own,
    // so they keep their `$`/`=` prefix and get no heading.
    if (line.startsWith('  ')) {
      out.push(line.trim())
      continue
    }
    const m = ROLE_RE.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const [, role, text] = m
    // A `synthetic_reason` role (`system_reminder`, `compaction_meta`, …) is not a speaker. It gets
    // its own heading, spelled as itself, so the receiving agent can tell injected context from a
    // human turn instead of inheriting someone's tooling as an instruction. One heading per message,
    // like every sibling renderer — merging consecutive same-role turns would erase where one ended.
    out.push(`## ${HEADINGS[role] ?? `Injected (${role})`}\n\n${text}`)
  }
  return out.join('\n\n')
}
