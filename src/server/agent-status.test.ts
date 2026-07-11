import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ServerPlatform } from './platform-server'
import { wireAgentStatus } from './agent-status'
import { IPC } from '../shared/ipc'
import { decodePtyData } from '../shared/rpc'

// A fake hook server that captures the listeners wireAgentStatus installs, so the test can
// fire raw + normalized events without binding a real port.
function fakeHooks() {
  let listener: ((e: unknown) => void) | undefined
  let raw: ((agentId: string, nodeId: string, payload: Record<string, unknown>) => void) | undefined
  return {
    hooks: {
      setListener: (cb: (e: unknown) => void) => {
        listener = cb
      },
      setRawListener: (cb: typeof raw) => {
        raw = cb
      }
    },
    fireNormalized: (e: unknown) => listener?.(e),
    fireRaw: (agentId: string, nodeId: string, payload: Record<string, unknown>) =>
      raw?.(agentId, nodeId, payload)
  }
}

// A recording tail so we can assert track/finish without touching the filesystem.
function recTail() {
  const calls: Array<{ m: string; args: unknown[] }> = []
  return {
    tail: {
      track: (...args: unknown[]) => calls.push({ m: 'track', args }),
      finish: (...args: unknown[]) => calls.push({ m: 'finish', args }),
      untrack: (...args: unknown[]) => calls.push({ m: 'untrack', args })
    },
    calls
  }
}

let dir: string, platform: ServerPlatform, sent: Array<{ channel: string; args: unknown[] }>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-agst-'))
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0' })
  sent = []
  // capture broadcasts by attaching a recording sink
  platform.attach({
    sendText: (json) => sent.push(JSON.parse(json)),
    sendBinary: (buf) => {
      const f = decodePtyData(buf)
      if (f) sent.push({ channel: `pty:data:${f.sessionId}`, args: [f.data] })
    }
  })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('wireAgentStatus', () => {
  it('broadcasts a normalized agent event on agent:status', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never })
    const ev = { nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'working' }
    fh.fireNormalized(ev)
    expect(sent).toContainEqual({ t: 'ev', channel: IPC.agentStatus, args: [ev] })
  })

  it('tracks a subagent on PreToolUse(Task) and finishes it on PostToolUse', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    // PreToolUse for a subagent tool → track
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu1',
      session_id: 's1'
    })
    expect(sub.calls.some((c) => c.m === 'track' && c.args[0] === 'tu1')).toBe(true)
    // PostToolUse (non-async) → finish
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu1',
      session_id: 's1',
      tool_response: { status: 'success' }
    })
    expect(sub.calls.some((c) => c.m === 'finish' && c.args[0] === 'tu1')).toBe(true)
  })

  it('ignores non-claude raw events', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    fh.fireRaw('codex', 'n1', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'x' })
    expect(sub.calls).toEqual([])
  })

  it('ptyDestroy untracks the node context tail and finishes its subagents, clearing the maps', () => {
    const fh = fakeHooks()
    const sub = recTail()
    const ctx = recTail()
    wireAgentStatus(platform, {
      hooks: fh.hooks as never,
      subagentTail: sub.tail as never,
      contextTail: ctx.tail as never
    })
    // A safe local transcript path so contextTail.track runs and nodeContextSession is set.
    const transcriptPath = path.join(os.homedir(), '.claude', 'projects', 't.jsonl')
    // Populate the maps: a raw PreToolUse(Task) sets nodeContextSession + tracks a subagent.
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu1',
      session_id: 's1',
      transcript_path: transcriptPath
    })
    // Node closes → ptyDestroy cast fires the teardown listener.
    platform.cast(
      platform.attach({ sendText: () => {}, sendBinary: () => {} }),
      IPC.ptyDestroy,
      ['n1']
    )
    expect(ctx.calls.some((c) => c.m === 'untrack' && c.args[0] === 's1')).toBe(true)
    expect(sub.calls.some((c) => c.m === 'finish' && c.args[0] === 'tu1')).toBe(true)
    // Re-destroying the same node is a harmless no-op (maps already cleared).
    const before = ctx.calls.length + sub.calls.length
    platform.cast(
      platform.attach({ sendText: () => {}, sendBinary: () => {} }),
      IPC.ptyDestroy,
      ['n1']
    )
    expect(ctx.calls.length + sub.calls.length).toBe(before)
  })
})
