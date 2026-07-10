import { describe, it, expect } from 'vitest'
import { buildFilesApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const calls: Array<{ kind: string; method: string; args: unknown[] }> = []
  return {
    calls,
    request: (method: string, ...args: unknown[]) => {
      calls.push({ kind: 'request', method, args })
      return Promise.resolve('R')
    },
    cast: (method: string, ...args: unknown[]) => calls.push({ kind: 'cast', method, args }),
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      calls.push({ kind: 'subscribe', method: channel, args: [] })
      return () => {}
    }
  }
}

describe('buildFilesApi', () => {
  it('fs/git/files members are request-shaped with the right channels', async () => {
    const c = fakeClient()
    const api = buildFilesApi(c as never)
    await api.fs.read('/x')
    await api.git.status('/repo')
    await api.git.showFile('/repo', 'HEAD', 'a.txt')
    await api.files.quickOpen('/repo')
    expect(c.calls).toEqual([
      { kind: 'request', method: IPC.fsRead, args: ['/x'] },
      { kind: 'request', method: IPC.gitStatus, args: ['/repo'] },
      { kind: 'request', method: IPC.gitShowFile, args: ['/repo', 'HEAD', 'a.txt'] },
      { kind: 'request', method: IPC.filesQuickOpen, args: ['/repo'] }
    ])
  })
  it('context.ensure is a cast; context.onUpdate/git.onCloneProgress subscribe', () => {
    const c = fakeClient()
    const api = buildFilesApi(c as never)
    api.context.ensure('sid', '/cwd', undefined)
    const un = api.context.onUpdate(() => {})
    const un2 = api.git.onCloneProgress(() => {})
    expect(c.calls[0]).toEqual({ kind: 'cast', method: IPC.contextEnsure, args: ['sid', '/cwd', undefined] })
    expect(c.calls[1]).toEqual({ kind: 'subscribe', method: IPC.contextUpdate, args: [] })
    expect(c.calls[2]).toEqual({ kind: 'subscribe', method: IPC.gitCloneProgress, args: [] })
    expect(typeof un).toBe('function')
    expect(typeof un2).toBe('function')
  })
})
