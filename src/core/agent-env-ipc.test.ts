import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { MODEL_GATEWAY_SECRET_REF } from '../shared/agents/model-gateway'
import { registerAgentEnvIpc } from './agent-env-ipc'
import { ModelGatewayCredentialService } from './model-gateway-credentials'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'

describe('model gateway discovery API-key expansion', () => {
  let fake: FakePlatform
  let fetchMock: ReturnType<typeof vi.fn>
  let inheritedKey: string | undefined
  let credentials: ModelGatewayCredentialService
  let storedKey: string | null

  beforeEach(async () => {
    inheritedKey = process.env.NODETERM_TEST_GATEWAY_KEY
    fake = fakePlatform()
    initPlatform(fake)
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5.5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    storedKey = null
    credentials = new ModelGatewayCredentialService({
      availability: 'encrypted',
      readForHost: async () => storedKey,
      save: async (value) => {
        storedKey = value
      },
      clear: async () => {
        storedKey = null
      }
    })
    await credentials.init()
    registerAgentEnvIpc(credentials)
  })

  afterEach(() => {
    if (inheritedKey === undefined) delete process.env.NODETERM_TEST_GATEWAY_KEY
    else process.env.NODETERM_TEST_GATEWAY_KEY = inheritedKey
    vi.unstubAllGlobals()
    resetPlatformForTests()
  })

  it('expands the key in core before authenticating model discovery', async () => {
    process.env.NODETERM_TEST_GATEWAY_KEY = 'vk-from-env'

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    })

    expect(result).toEqual({
      models: [{ id: 'openai/gpt-5.5', provider: 'openai' }]
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bifrost.example.test/v1/models',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer vk-from-env',
          'x-bf-vk': 'vk-from-env',
          Accept: 'application/json'
        }
      })
    )
  })

  it('does not make a request when the referenced variable is unset', async () => {
    delete process.env.NODETERM_TEST_GATEWAY_KEY

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://bifrost.example.test',
      apiKey: '${env:NODETERM_TEST_GATEWAY_KEY}'
    })

    expect(result).toEqual({
      models: [],
      error:
        'Gateway API key environment variable is unset: ${env:NODETERM_TEST_GATEWAY_KEY}.'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps a literal key write-only and uses it for discovery', async () => {
    await expect(
      fake.handlers[IPC.agentGatewayCredentialSave]('stored-gateway-key')
    ).resolves.toEqual({ hasStoredKey: true, storage: 'encrypted' })

    const result = await fake.handlers[IPC.agentDiscoverModels]({
      baseUrl: 'https://gateway.example.test',
      apiKey: MODEL_GATEWAY_SECRET_REF
    })

    expect(result).toEqual({
      models: [{ id: 'openai/gpt-5.5', provider: 'openai' }]
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.test/v1/models',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer stored-gateway-key',
          'x-bf-vk': 'stored-gateway-key',
          Accept: 'application/json'
        }
      })
    )
    await expect(fake.handlers[IPC.agentGatewayCredentialClear]()).resolves.toEqual({
      hasStoredKey: false,
      storage: 'encrypted'
    })
  })
})
