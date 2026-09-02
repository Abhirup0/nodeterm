import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { chatMessagesFromGrok } from './grok-chat'

const RAW = fs.readFileSync(path.join(__dirname, '__fixtures__/grok/chat_history.jsonl'), 'utf8')

describe('chatMessagesFromGrok', () => {
  it('builds bubbles from a real session', () => {
    const msgs = chatMessagesFromGrok(RAW)
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('never gives harness-injected text the user role', () => {
    // The panel has two roles and no third place to put tooling text. grok marks these only with
    // `synthetic_reason` under the `user` type, so an unlabelled read shows a skill reminder in the
    // same shape as a typed prompt. Every injected line is assistant-side and carries its reason.
    const msgs = chatMessagesFromGrok(RAW)
    for (const reason of [
      'system_reminder',
      'compaction_meta',
      'project_instructions',
      'task_completed'
    ]) {
      const hit = msgs.find((m) =>
        m.parts.some((p) => p.kind === 'text' && p.text.startsWith(`[${reason}]`))
      )
      expect(hit, reason).toBeDefined()
      expect(hit!.role).toBe('assistant')
    }
    // …and no user bubble carries one.
    for (const m of msgs.filter((x) => x.role === 'user')) {
      for (const p of m.parts) {
        if (p.kind === 'text') expect(p.text.startsWith('[')).toBe(false)
      }
    }
  })

  it('correlates a tool result back onto the call it answers', () => {
    const msgs = chatMessagesFromGrok(RAW)
    const tools = msgs.flatMap((m) => m.parts).filter((p) => p.kind === 'tool')
    expect(tools.length).toBeGreaterThan(0)
    // The fixture's results reference ids that its assistant lines declare, so at least one lands.
    expect(tools.some((t) => t.kind === 'tool' && typeof t.result === 'string')).toBe(true)
    // A result is never a bubble of its own.
    expect(msgs.some((m) => m.parts.some((p) => p.kind === 'text' && p.text.startsWith('  =')))).toBe(
      false
    )
  })

  it('emits no model reasoning', () => {
    const msgs = chatMessagesFromGrok(RAW)
    const all = JSON.stringify(msgs)
    expect(all).not.toContain('encrypted_content')
  })

  it('is empty, not thrown, for junk and for nothing', () => {
    expect(chatMessagesFromGrok('')).toEqual([])
    expect(chatMessagesFromGrok('{broken\n')).toEqual([])
  })

  it('does not parse a CLAUDE transcript — the two readers are not interchangeable', () => {
    // A claude line nests its content under `message.content`, which this reader does not read.
    // The point is that pointing the wrong reader at a file yields NOTHING rather than a plausible
    // half-transcript: silence is the failure we can see.
    const claudeLine = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello from claude' }] }
    })
    expect(chatMessagesFromGrok(claudeLine)).toEqual([])
  })
})
