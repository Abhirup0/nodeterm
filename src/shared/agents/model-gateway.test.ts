import { describe, expect, it } from 'vitest'
import {
  modelGatewayEnv,
  modelGatewayRoutes,
  modelsForAgent,
  parseGatewayModels,
  withAgentModel
} from './model-gateway'
import {
  setCustomAgentBaseResolver,
  type AgentId,
  type BuiltinAgentId
} from './config'

describe('modelGatewayRoutes', () => {
  it('derives Bifrost discovery and protocol routes from one root', () => {
    expect(modelGatewayRoutes('https://bifrost.example.test/root///')).toEqual({
      discovery: 'https://bifrost.example.test/root/v1/models',
      openai: 'https://bifrost.example.test/root/openai/v1',
      anthropic: 'https://bifrost.example.test/root/anthropic'
    })
  })

  it('refuses non-http, credential-bearing, and ambiguous URLs', () => {
    expect(modelGatewayRoutes('file:///tmp/gateway')).toBeNull()
    expect(modelGatewayRoutes('https://key@example.test')).toBeNull()
    expect(modelGatewayRoutes('https://example.test?route=other')).toBeNull()
    expect(modelGatewayRoutes('https://example.test/#fragment')).toBeNull()
    expect(modelGatewayRoutes('not a URL')).toBeNull()
  })
})

describe('parseGatewayModels', () => {
  it('normalizes, sorts, and deduplicates an OpenAI-compatible model list', () => {
    expect(
      parseGatewayModels({
        data: [
          { id: 'openai/gpt-5', owned_by: 'openai' },
          { id: 'anthropic/claude-sonnet-4', name: 'Sonnet' },
          { id: 'openai/gpt-5', name: 'Latest wins' },
          { id: '' },
          null
        ]
      })
    ).toEqual([
      { id: 'anthropic/claude-sonnet-4', name: 'Sonnet', provider: 'anthropic' },
      { id: 'openai/gpt-5', name: 'Latest wins', provider: 'openai' }
    ])
  })

  it('fails closed on an unexpected response shape', () => {
    expect(parseGatewayModels({ models: [{ id: 'gpt-5' }] })).toEqual([])
    expect(parseGatewayModels(null)).toEqual([])
  })
})

describe('agent mappings', () => {
  const gateway = { baseUrl: 'https://bifrost.example.test', apiKey: 'vk-secret' }

  it('maps the shared gateway to Claude and Codex environment variables', () => {
    expect(modelGatewayEnv(gateway, 'claude')).toEqual({
      ANTHROPIC_BASE_URL: 'https://bifrost.example.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'vk-secret'
    })
    expect(modelGatewayEnv(gateway, 'codex')).toEqual({
      OPENAI_BASE_URL: 'https://bifrost.example.test/openai/v1',
      OPENAI_API_KEY: 'vk-secret'
    })
    expect(modelGatewayEnv(gateway, 'gemini')).toEqual({})
  })

  it('quotes model ids and refuses unsupported/control-bearing values', () => {
    expect(withAgentModel('codex resume abc', 'codex', "openai/o'model")).toBe(
      "codex resume abc --model 'openai/o'\\''model'"
    )
    expect(withAgentModel('gemini --resume abc', 'gemini', 'gemini/pro')).toBe(
      'gemini --resume abc'
    )
    expect(withAgentModel('claude', 'claude', 'bad\nmodel')).toBe('claude')
  })

  it('offers every Bifrost model to each capable harness', () => {
    const models = parseGatewayModels({
      data: [
        { id: 'openai/gpt-5' },
        { id: 'anthropic/claude-sonnet-4' },
        { id: 'claude-alias' }
      ]
    })
    const all = [
      'anthropic/claude-sonnet-4',
      'claude-alias',
      'openai/gpt-5'
    ]
    expect(modelsForAgent(models, 'claude').map((m) => m.id)).toEqual(all)
    expect(modelsForAgent(models, 'codex').map((m) => m.id)).toEqual(all)
    expect(modelsForAgent(models, 'gemini')).toEqual([])
  })

  it('inherits mappings and filtering through a custom base agent', () => {
    setCustomAgentBaseResolver((id: AgentId): BuiltinAgentId | undefined =>
      id === 'custom:proxy' ? 'claude' : undefined
    )
    try {
      expect(modelGatewayEnv(gateway, 'custom:proxy')).toEqual({
        ANTHROPIC_BASE_URL: 'https://bifrost.example.test/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'vk-secret'
      })
      expect(withAgentModel('proxy', 'custom:proxy', 'anthropic/claude-opus')).toBe(
        "proxy --model 'anthropic/claude-opus'"
      )
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })
})
