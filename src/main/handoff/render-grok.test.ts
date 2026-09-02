import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { renderGrokTranscript } from './render-grok'

// The fixture is cut from a REAL grok session (see core/__fixtures__/grok/chat_history.jsonl):
// every line shape grok emits, including a deliberately truncated one.
const RAW = fs.readFileSync(
  path.join(__dirname, '../../core/__fixtures__/grok/chat_history.jsonl'),
  'utf8'
)

describe('renderGrokTranscript', () => {
  it('renders each turn under its own heading', () => {
    const md = renderGrokTranscript(RAW)
    expect(md).toContain('## User')
    expect(md).toContain('## Assistant')
    expect(md).toContain('## System')
  })

  it('never presents harness-injected text as something the human said', () => {
    // This is the rule that matters most in a handoff: the receiving agent reads a `## User`
    // heading as an instruction from the person. grok files skill reminders, compaction notes,
    // project instructions and subagent completions under the `user` role, marked only by
    // `synthetic_reason` — so each gets its own heading, spelled as itself.
    const md = renderGrokTranscript(RAW)
    for (const reason of [
      'system_reminder',
      'compaction_meta',
      'project_instructions',
      'task_completed'
    ]) {
      expect(md).toContain(`## Injected (${reason})`)
    }
  })

  it('keeps tool calls attached to the message above, not as speakers of their own', () => {
    const md = renderGrokTranscript(RAW)
    // Tool lines keep their `$` marker and never gain a heading.
    expect(md).toMatch(/\$ \w+/)
    expect(md).not.toContain('## $')
  })

  it('omits model reasoning, which is unreadable and not ours to forward', () => {
    // `reasoning` lines carry `encrypted_content`. Three of them sit in the fixture; none of their
    // ciphertext may appear in a document handed to another agent.
    expect(renderGrokTranscript(RAW)).not.toContain('encrypted_content')
    expect(renderGrokTranscript(RAW)).not.toContain('## Reasoning')
  })

  it('returns an empty document rather than throwing on junk', () => {
    expect(renderGrokTranscript('')).toBe('')
    expect(renderGrokTranscript('{not json\n\n')).toBe('')
  })
})
