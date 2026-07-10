import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createContextTail, parseLatestUsage, parseTaskNotifications } from './context-tail'

describe('parseLatestUsage', () => {
  it('returns the LAST assistant usage in the text (sum of input + cache tokens)', () => {
    const text = [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-y', usage: { input_tokens: 100, cache_creation_input_tokens: 20 } } })
    ].join('\n')
    expect(parseLatestUsage(text)).toEqual({ used: 120, model: 'claude-y' })
  })
  it('ignores non-assistant lines, zero-usage, and garbled JSON; null when none', () => {
    expect(parseLatestUsage('not json\n{"type":"assistant","message":{"usage":{"input_tokens":0}}}')).toBeNull()
    expect(parseLatestUsage('')).toBeNull()
  })
})

// A queue-operation transcript line carrying a completed async subagent's notification,
// shaped like the real ones Claude Code writes into the parent .jsonl.
function notificationLine(toolUseId: string, result = 'agent findings'): string {
  const content = [
    '<task-notification>',
    '<task-id>a3ff80d</task-id>',
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    '<output-file>/tmp/tasks/a3ff80d.output</output-file>',
    '<status>completed</status>',
    '<summary>Agent "Explore" finished</summary>',
    `<result>${result}</result>`,
    '</task-notification>'
  ].join('\n')
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content })
}

describe('parseTaskNotifications', () => {
  it('extracts toolUseId, status, summary and result from a queue-operation line', () => {
    const [n] = parseTaskNotifications(notificationLine('tu1', 'found 3 files'))
    expect(n).toMatchObject({
      toolUseId: 'tu1',
      status: 'completed',
      summary: 'Agent "Explore" finished',
      result: 'found 3 files'
    })
  })

  it('ignores unrelated lines, attachment echoes of the notification, and garbled JSON', () => {
    const text = [
      'garbled',
      JSON.stringify({ type: 'assistant', message: {} }),
      // the same notification is echoed later as an attachment line — must not double-fire
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification><tool-use-id>tu1</tool-use-id></task-notification>' } }),
      notificationLine('tu2')
    ].join('\n')
    const ns = parseTaskNotifications(text)
    expect(ns).toHaveLength(1)
    expect(ns[0].toolUseId).toBe('tu2')
  })
})

describe('createContextTail — task notifications', () => {
  it('fires onTaskNotification even when the line lands torn across two reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtail-'))
    const file = path.join(dir, 'sess.jsonl')
    const line = notificationLine('tu-torn')
    fs.writeFileSync(file, line.slice(0, 40)) // first half, no newline
    const onTaskNotification = vi.fn()
    const send = vi.fn()
    const tail = createContextTail(send, { onTaskNotification })
    tail.track('s1', file)
    await new Promise((r) => setTimeout(r, 1200)) // ≥1 poll sees the partial line
    fs.appendFileSync(file, line.slice(40) + '\n')
    await new Promise((r) => setTimeout(r, 1300)) // next poll completes it
    expect(onTaskNotification).toHaveBeenCalledTimes(1)
    expect(onTaskNotification.mock.calls[0][0]).toBe('s1')
    expect(onTaskNotification.mock.calls[0][1]).toMatchObject({ toolUseId: 'tu-torn' })
    tail.untrack('s1')
  }, 8000)
})
