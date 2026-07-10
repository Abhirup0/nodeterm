import { describe, it, expect } from 'vitest'
import { buildAgentApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const subs: Array<{ channel: string }> = []
  return {
    subs,
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      subs.push({ channel })
      return () => {}
    }
  }
}

describe('buildAgentApi', () => {
  it('onAgentStatus / onSubagentActivity subscribe to the right channels and return an unsub', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    const un1 = api.onAgentStatus(() => {})
    const un2 = api.onSubagentActivity(() => {})
    expect(c.subs).toEqual([
      { channel: IPC.agentStatus },
      { channel: IPC.agentSubagentActivity }
    ])
    expect(typeof un1).toBe('function')
    expect(typeof un2).toBe('function')
  })
})
