import { describe, expect, it, vi } from 'vitest'
import { MODEL_GATEWAY_SECRET_REF } from '../shared/agents/model-gateway'
import {
  migrateLegacyModelGatewayKey,
  ModelGatewayCredentialService
} from './model-gateway-credentials'

function store(initial: string | null = null) {
  let value = initial
  return {
    availability: 'encrypted' as const,
    readForHost: vi.fn(async () => value),
    save: vi.fn(async (next: string) => {
      value = next
    }),
    clear: vi.fn(async () => {
      value = null
    })
  }
}

describe('ModelGatewayCredentialService', () => {
  it('loads, saves, and clears without exposing the value through status', async () => {
    const backing = store('saved-key')
    const service = new ModelGatewayCredentialService(backing)
    await service.init()
    expect(service.status()).toEqual({ hasStoredKey: true, storage: 'encrypted' })
    expect(service.readForHost()).toBe('saved-key')

    await service.save(' replacement-key ')
    expect(backing.save).toHaveBeenCalledWith('replacement-key')
    expect(service.readForHost()).toBe('replacement-key')

    await service.clear()
    expect(service.status().hasStoredKey).toBe(false)
  })

  it('migrates only legacy literals after the secret write succeeds', async () => {
    const backing = store()
    const service = new ModelGatewayCredentialService(backing)
    await service.init()

    await expect(
      migrateLegacyModelGatewayKey(
        { baseUrl: 'https://gateway.example.test', apiKey: 'legacy-key' },
        service
      )
    ).resolves.toEqual({
      baseUrl: 'https://gateway.example.test',
      apiKey: MODEL_GATEWAY_SECRET_REF
    })
    expect(backing.save).toHaveBeenCalledWith('legacy-key')

    await expect(
      migrateLegacyModelGatewayKey(
        { baseUrl: 'https://gateway.example.test', apiKey: '${env:GATEWAY_KEY}' },
        service
      )
    ).resolves.toBeNull()
  })
})
