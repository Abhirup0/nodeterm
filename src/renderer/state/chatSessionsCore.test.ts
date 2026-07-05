// src/renderer/state/chatSessionsCore.test.ts
import { describe, expect, it } from 'vitest'
import { applyChatEvent, emptyChatNodeState } from './chatSessionsCore'

const s0 = emptyChatNodeState

describe('applyChatEvent', () => {
  it('accumulates deltas into the stream buffers', () => {
    let s = applyChatEvent(s0, { kind: 'delta', block: 'text', text: 'he' })
    s = applyChatEvent(s, { kind: 'delta', block: 'text', text: 'y' })
    s = applyChatEvent(s, { kind: 'delta', block: 'thinking', text: 'hm' })
    expect(s.streamText).toBe('hey')
    expect(s.streamThinking).toBe('hm')
  })

  it('message commits and clears the stream buffers (reconcile)', () => {
    let s = applyChatEvent(s0, { kind: 'delta', block: 'text', text: 'partial…' })
    s = applyChatEvent(s, { kind: 'message', msg: { role: 'assistant', parts: [{ kind: 'text', text: 'full' }] } })
    expect(s.streamText).toBe('')
    expect(s.messages.at(-1)?.parts).toEqual([{ kind: 'text', text: 'full' }])
  })

  it('tool + tool-result pair up by toolUseId', () => {
    let s = applyChatEvent(s0, { kind: 'tool', toolUseId: 't1', name: 'Bash', arg: 'ls' })
    s = applyChatEvent(s, { kind: 'tool-result', toolUseId: 't1', result: 'ok' })
    expect(s.tools.t1).toMatchObject({ name: 'Bash', result: 'ok' })
    expect(s.toolOrder).toEqual(['t1'])
  })

  it('turn-done accumulates cost, clears working + per-turn tool order', () => {
    let s = { ...s0, working: true }
    s = applyChatEvent(s, { kind: 'turn-done', costUsd: 0.1 })
    s = applyChatEvent(s, { kind: 'turn-done', costUsd: 0.05 })
    expect(s.costUsd).toBeCloseTo(0.15)
    expect(s.working).toBe(false)
    expect(s.toolOrder).toEqual([])
  })

  it('turn-done folds the turn tools into a committed assistant message, then clears toolOrder', () => {
    let s = applyChatEvent(s0, { kind: 'tool', toolUseId: 't1', name: 'Bash', arg: 'ls', summary: undefined })
    s = applyChatEvent(s, { kind: 'tool', toolUseId: 't2', name: 'Write', arg: '/f.ts', summary: { filePath: '/f.ts', added: 3, removed: 0 } })
    s = applyChatEvent(s, { kind: 'tool-result', toolUseId: 't1', result: 'out' })
    s = applyChatEvent(s, { kind: 'turn-done', costUsd: 0.02 })
    expect(s.toolOrder).toEqual([])
    // A single synthetic assistant message carries both tools in order, preserving result + summary.
    expect(s.messages).toEqual([
      {
        role: 'assistant',
        parts: [
          { kind: 'tool', name: 'Bash', arg: 'ls', result: 'out', summary: undefined },
          { kind: 'tool', name: 'Write', arg: '/f.ts', result: undefined, summary: { filePath: '/f.ts', added: 3, removed: 0 } }
        ]
      }
    ])
  })

  it('turn-done with no tools appends no message', () => {
    let s = applyChatEvent(s0, { kind: 'message', msg: { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] } })
    const before = s.messages
    s = applyChatEvent(s, { kind: 'turn-done', costUsd: 0.01 })
    expect(s.messages).toBe(before)
    expect(s.toolOrder).toEqual([])
  })

  it('permission set + cleared', () => {
    let s = applyChatEvent(s0, { kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {} })
    expect(s.permission?.requestId).toBe('r1')
    s = applyChatEvent(s, { kind: 'permission-done', requestId: 'r1' })
    expect(s.permission).toBeUndefined()
  })

  it('session stores id + slash commands; queue replaces; error stores', () => {
    let s = applyChatEvent(s0, { kind: 'session', sessionId: 'abc', slashCommands: ['/compact'] })
    s = applyChatEvent(s, { kind: 'queue', items: [{ id: 'q-1', text: 'next' }] })
    s = applyChatEvent(s, { kind: 'error', message: 'boom', fatal: true })
    expect(s.sessionId).toBe('abc')
    expect(s.slashCommands).toEqual(['/compact'])
    expect(s.queue).toEqual([{ id: 'q-1', text: 'next' }])
    expect(s.error).toEqual({ message: 'boom', fatal: true })
  })
})
