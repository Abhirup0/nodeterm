import { describe, expect, it } from 'vitest'
import { readExistingSessionHostIdentity } from './existing-host-state'

const statePath = 'session-host.json'
const tokenPath = 'session-host.token'
const endpoint = 'session-host-endpoint'
const bearerToken = 'a'.repeat(64)
const validState = JSON.stringify({
  pid: 42,
  endpoint,
  tokenPath,
  startedAt: 1234,
  protocolVersion: 2
})

function codedError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: injected read failure`)
  error.code = code
  return error
}

function reader(entries: Record<string, string | Error>): (filePath: string) => string {
  return (filePath) => {
    const value = entries[filePath]
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`unexpected read: ${filePath}`)
    return value
  }
}

function options(readText: (filePath: string) => string) {
  return { expectedEndpoint: endpoint, expectedTokenPath: tokenPath, readText }
}

describe('existing session-host ownership reads', () => {
  it('returns a complete identity only after both valid files are read', () => {
    const result = readExistingSessionHostIdentity(statePath, {
      ...options(reader({ [statePath]: validState, [tokenPath]: bearerToken }))
    })

    expect(result).toEqual({
      kind: 'ready',
      state: {
        pid: 42,
        endpoint,
        tokenPath,
        startedAt: 1234,
        protocolVersion: 2
      },
      token: bearerToken
    })
  })

  it.each(['state', 'token'] as const)('treats only an ENOENT %s file as absent', (missing) => {
    const entries: Record<string, string | Error> = {
      [statePath]: missing === 'state' ? codedError('ENOENT') : validState,
      [tokenPath]: codedError('ENOENT')
    }

    expect(
      readExistingSessionHostIdentity(statePath, options(reader(entries)))
    ).toEqual({ kind: 'absent', missing })
  })

  it.each(['EISDIR', 'EACCES', 'EIO'])('propagates a %s state read instead of claiming absence', (code) => {
    const failure = codedError(code)

    expect(() =>
      readExistingSessionHostIdentity(statePath, {
        ...options(reader({ [statePath]: failure }))
      })
    ).toThrow(failure)
  })

  it.each(['EISDIR', 'EACCES', 'EIO'])('propagates a %s token read instead of claiming absence', (code) => {
    const failure = codedError(code)

    expect(() =>
      readExistingSessionHostIdentity(statePath, {
        ...options(reader({ [statePath]: validState, [tokenPath]: failure }))
      })
    ).toThrow(failure)
  })

  it.each([
    ['', 'file is empty'],
    ['   \n', 'file is empty'],
    ['{broken', 'file is not valid JSON'],
    ['null', 'root must be an object'],
    ['[]', 'root must be an object'],
    ['{}', 'pid must be a positive integer'],
    [JSON.stringify({ ...JSON.parse(validState), endpoint: '' }), 'endpoint must be a non-empty string'],
    [JSON.stringify({ ...JSON.parse(validState), tokenPath: null }), 'tokenPath must be a non-empty string'],
    [JSON.stringify({ ...JSON.parse(validState), protocolVersion: 0 }), 'protocolVersion must be a positive integer']
  ])('rejects corrupt state %j without reading a token', (raw, reason) => {
    let tokenReads = 0
    expect(() =>
      readExistingSessionHostIdentity(statePath, {
        ...options((filePath) => {
          if (filePath === statePath) return raw
          tokenReads++
          return bearerToken
        })
      })
    ).toThrow(reason)
    expect(tokenReads).toBe(0)
  })

  it.each(['', '  \r\n'])('rejects an empty token instead of claiming absence', (token) => {
    expect(() =>
      readExistingSessionHostIdentity(statePath, {
        ...options(reader({ [statePath]: validState, [tokenPath]: token }))
      })
    ).toThrow('invalid session-host token: file is empty')
  })

  it.each([
    ['not-hex', 'non-hex text'],
    ['A'.repeat(64), 'uppercase hex'],
    ['a'.repeat(63), '63 hex characters'],
    ['a'.repeat(65), '65 hex characters'],
    [`${'a'.repeat(64)}\n`, 'newline-padded hex'],
    [` ${'a'.repeat(64)}`, 'space-padded hex']
  ])('rejects %s token bytes before they can become hello credentials (%s)', (token) => {
    let helloCredential: string | undefined
    expect(() => {
      const result = readExistingSessionHostIdentity(
        statePath,
        options(reader({ [statePath]: validState, [tokenPath]: token }))
      )
      if (result.kind === 'ready') helloCredential = result.token
    }).toThrow('expected 64 lowercase hexadecimal characters')
    expect(helloCredential).toBeUndefined()
  })

  it.each([
    ['endpoint', { endpoint: 'attacker-endpoint' }],
    ['tokenPath', { tokenPath: 'attacker.token' }]
  ] as const)('rejects a state-file %s redirect before any redirected read or hello', (field, change) => {
    const reads: string[] = []
    let helloTarget: string | undefined
    const tampered = JSON.stringify({ ...JSON.parse(validState), ...change })

    expect(() => {
      const result = readExistingSessionHostIdentity(
        statePath,
        options((filePath) => {
          reads.push(filePath)
          if (filePath === statePath) return tampered
          return bearerToken
        })
      )
      if (result.kind === 'ready') helloTarget = result.state.endpoint
    }).toThrow(field === 'endpoint' ? 'derived endpoint' : 'derived token path')
    expect(reads).toEqual([statePath])
    expect(helloTarget).toBeUndefined()
  })
})
