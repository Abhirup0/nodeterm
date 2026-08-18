import type { SecretStore } from './secret-store'
import {
  MODEL_GATEWAY_SECRET_REF,
  modelGatewayCredentialKind,
  type ModelGatewayCredentialStatus,
  type ModelGatewaySettings
} from '../shared/agents/model-gateway'

export const MODEL_GATEWAY_SECRET_FILE = 'model-gateway-api-key.json'

/**
 * Process-local facade over the platform's secret store. PTY creation is synchronous at the point
 * where its environment is assembled, so the secret is loaded once during shell startup and kept
 * in memory; saves/clears update disk first and only then publish the new cached value.
 */
export class ModelGatewayCredentialService {
  private key: string | null = null

  constructor(private readonly store: SecretStore) {}

  async init(): Promise<void> {
    this.key = await this.store.readForHost()
  }

  readForHost(): string | null {
    return this.key
  }

  status(): ModelGatewayCredentialStatus {
    return {
      hasStoredKey: this.key !== null,
      storage: this.store.availability
    }
  }

  async save(key: string): Promise<ModelGatewayCredentialStatus> {
    const value = key.trim()
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw new Error('invalid-api-key')
    }
    await this.store.save(value)
    this.key = value
    return this.status()
  }

  async clear(): Promise<ModelGatewayCredentialStatus> {
    await this.store.clear()
    this.key = null
    return this.status()
  }
}

/**
 * One-time migration for builds that wrote a literal gateway key into settings.json. Environment
 * references and the new secret sentinel stay untouched. The caller persists the returned
 * settings only after `save` succeeds, so a locked keyring or disk failure never destroys the sole
 * copy of a legacy credential.
 */
export async function migrateLegacyModelGatewayKey(
  settings: ModelGatewaySettings,
  credentials: ModelGatewayCredentialService
): Promise<ModelGatewaySettings | null> {
  if (modelGatewayCredentialKind(settings.apiKey) !== 'legacy-literal') return null
  await credentials.save(settings.apiKey)
  return { ...settings, apiKey: MODEL_GATEWAY_SECRET_REF }
}
