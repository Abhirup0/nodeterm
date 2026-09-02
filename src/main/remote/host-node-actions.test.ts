// The phone session-list long-press verbs (`node.wake` / `node.refresh` / `node.rename`) —
// renderer nudges in the `agent:wake` shape. What these tests pin:
//   - Absent injection ⇒ every verb answers an honest "not served" (a pre-feature host).
//   - The client-sent node id is validated (non-string / empty / over REF_MAX_LEN / control
//     chars ⇒ refused, callback never invoked) — these verbs deliberately take a client id
//     (they fire from the LIST, where no stream exists), so the validation is the envelope.
//   - A rename title is sanitized HERE, before it rides toward a `/rename` command line:
//     control chars (ESC/CSI, \r\n) stripped, whitespace collapsed, TITLE_MAX clamp, and an
//     empty-after-sanitize title refused.
//   - The answer means "delivered to a live desktop window": a false callback (window gone)
//     answers ok:false, never a silent success.
import { describe, expect, it, vi } from 'vitest'
import { REF_MAX_LEN } from '../../shared/presence'
import { TITLE_MAX } from '../../core/project-node-append'
import {
  createHostHandlers,
  type HostFsOps,
  type HostNodeActions,
  type HostPtyManager,
  type HostRelaySocket
} from './host-service'

function makeFakes(actions?: Partial<HostNodeActions> & { delivered?: boolean }) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  const delivered = actions?.delivered ?? true
  const nodeActions: HostNodeActions = {
    wake: vi.fn(() => delivered),
    refresh: vi.fn(() => delivered),
    rename: vi.fn(() => delivered),
    ...actions
  }
  const handlers = createHostHandlers(
    {} as HostPtyManager,
    socket,
    fs,
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    nodeActions
  )
  return { handlers, responses, nodeActions }
}

function makeUnserved() {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => [])
  return { handlers, responses }
}

describe('node.* verbs refuse honestly when not injected (pre-feature host)', () => {
  it.each(['node.wake', 'node.refresh', 'node.rename'])('%s answers not served', (method) => {
    const { handlers, responses } = makeUnserved()
    handlers.onRpc({ id: '1', method, params: { nodeId: 'term-a-1', title: 'x' } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: `${method} is not served on this host.` } }
    ])
  })
})

describe('node id validation (client-sent id — the whole envelope for these verbs)', () => {
  it.each([
    ['missing', {}],
    ['non-string', { nodeId: 42 }],
    ['empty', { nodeId: '' }],
    ['over REF_MAX_LEN', { nodeId: 'a'.repeat(REF_MAX_LEN + 1) }],
    ['control chars', { nodeId: 'term-a\x1b[2J-1' }],
    ['newline', { nodeId: 'term-a\n-1' }]
  ])('refuses a %s node id and never invokes the callback', (_label, params) => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.wake', params })
    expect(responses).toEqual([{ id: '1', ok: false, body: { message: 'Invalid node id.' } }])
    expect(nodeActions.wake).not.toHaveBeenCalled()
  })

  it('accepts an ordinary desktop node id and answers ok on delivery', () => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.wake', params: { nodeId: 'term-lz0abc-x1' } })
    expect(nodeActions.wake).toHaveBeenCalledWith('term-lz0abc-x1')
    expect(responses).toEqual([{ id: '1', ok: true, body: {} }])
  })
})

describe('node.refresh', () => {
  it('routes to the refresh callback', () => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.refresh', params: { nodeId: 'term-a-1' } })
    expect(nodeActions.refresh).toHaveBeenCalledWith('term-a-1')
    expect(nodeActions.wake).not.toHaveBeenCalled()
    expect(responses[0]?.ok).toBe(true)
  })
})

describe('node.rename title sanitation (before anything rides toward /rename)', () => {
  it('strips ESC/CSI and newlines, collapses whitespace', () => {
    const { handlers, nodeActions } = makeFakes()
    handlers.onRpc({
      id: '1',
      method: 'node.rename',
      params: { nodeId: 'term-a-1', title: 'fix\x1b[201~ the\r\nbug  now' }
    })
    // ESC stripped (its CSI tail "[201~" survives as plain text — the ESC is what made it
    // structure), \r\n → single space, runs collapsed.
    expect(nodeActions.rename).toHaveBeenCalledWith('term-a-1', 'fix [201~ the bug now')
  })

  it('clamps to TITLE_MAX (the registrar ceiling)', () => {
    const { handlers, nodeActions } = makeFakes()
    handlers.onRpc({
      id: '1',
      method: 'node.rename',
      params: { nodeId: 'term-a-1', title: 'x'.repeat(TITLE_MAX + 50) }
    })
    expect(nodeActions.rename).toHaveBeenCalledWith('term-a-1', 'x'.repeat(TITLE_MAX))
  })

  it.each([
    ['missing', undefined],
    ['non-string', 7],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['control-only', '\x1b\x1b\r\n']
  ])('refuses a %s title without invoking the callback', (_label, title) => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.rename', params: { nodeId: 'term-a-1', title } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: 'node.rename requires a non-empty title.' } }
    ])
    expect(nodeActions.rename).not.toHaveBeenCalled()
  })
})

describe('delivery is the answer, never assumed', () => {
  it('answers ok:false when the desktop window is gone', () => {
    const { handlers, responses } = makeFakes({ delivered: false })
    handlers.onRpc({ id: '1', method: 'node.refresh', params: { nodeId: 'term-a-1' } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: 'The desktop window is not available.' } }
    ])
  })
})
