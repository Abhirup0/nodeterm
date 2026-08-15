// Main/server IPC handlers for custom-agent previews and model-gateway credentials. Env expansion
// runs here (against the real `process.env`) because the renderer has no process environment of
// its own; literal gateway keys cross this boundary write-only and are read back only by core.

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { assembleLaunchCommand, type LaunchInputs } from '../shared/agents/launch'
import {
  modelGatewayRoutes,
  parseGatewayModels,
  resolveModelGatewayApiKey,
  type ModelDiscoveryResult,
  type ModelGatewaySettings
} from '../shared/agents/model-gateway'
import type { ModelGatewayCredentialService } from './model-gateway-credentials'

const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * Query model discovery from core rather than the renderer: gateways commonly omit browser CORS,
 * and the API key should never be interpolated into a terminal command. Every failure is returned
 * as data so opening Settings or a context menu cannot create an unhandled rejection.
 */
async function discoverModels(
  settings: ModelGatewaySettings,
  storedSecret: string | null
): Promise<ModelDiscoveryResult> {
  const routes = modelGatewayRoutes(settings?.baseUrl ?? '')
  const resolvedKey = resolveModelGatewayApiKey(
    settings?.apiKey ?? '',
    process.env,
    storedSecret
  )
  const apiKey = resolvedKey.value
  if (!routes) return { models: [], error: 'Enter a valid HTTP(S) gateway URL.' }
  if (resolvedKey.missing.length) {
    const refs = resolvedKey.missing.map((name) => `\${env:${name}}`).join(', ')
    return {
      models: [],
      error: `Gateway API key environment ${resolvedKey.missing.length === 1 ? 'variable is' : 'variables are'} unset: ${refs}.`
    }
  }
  if (resolvedKey.storedSecretMissing) {
    return { models: [], error: 'Save a gateway API key or select an environment variable.' }
  }
  if (!apiKey) return { models: [], error: 'Enter an API key.' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch(routes.discovery, {
      headers: {
        // Authorization is the OpenAI-compatible convention used by LiteLLM and
        // modern Bifrost keys. Older Bifrost virtual keys require x-bf-vk.
        Authorization: `Bearer ${apiKey}`,
        'x-bf-vk': apiKey,
        Accept: 'application/json'
      },
      signal: controller.signal
    })
    if (!response.ok) {
      return { models: [], error: `Model discovery failed (HTTP ${response.status}).` }
    }
    const models = parseGatewayModels(await response.json())
    return models.length
      ? { models }
      : { models: [], error: 'The gateway returned no usable models.' }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return {
      models: [],
      error: timedOut
        ? 'Model discovery timed out.'
        : `Model discovery failed: ${err instanceof Error ? err.message : 'unknown error'}`
    }
  } finally {
    clearTimeout(timer)
  }
}

/** A string-only snapshot of `process.env` (undefined entries omitted), for `${env:VAR}` expansion
 *  in the renderer's preview. */
function envSnapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** Register env snapshot, preview, discovery, and write-only gateway-credential handlers. */
export function registerAgentEnvIpc(credentials?: ModelGatewayCredentialService): void {
  platform().handle(IPC.envSnapshot, () => envSnapshot())
  platform().handle(IPC.agentPreviewCommand, (inputs: LaunchInputs) =>
    assembleLaunchCommand(inputs, envSnapshot())
  )
  platform().handle(IPC.agentDiscoverModels, (settings: ModelGatewaySettings) =>
    discoverModels(settings, credentials?.readForHost() ?? null)
  )
  platform().handle(IPC.agentGatewayCredentialStatus, () =>
    credentials?.status() ?? { hasStoredKey: false, storage: 'unavailable' as const }
  )
  platform().handle(IPC.agentGatewayCredentialSave, (apiKey: string) => {
    if (!credentials) throw new Error('gateway-secret-storage-unavailable')
    return credentials.save(apiKey)
  })
  platform().handle(IPC.agentGatewayCredentialClear, () => {
    if (!credentials) throw new Error('gateway-secret-storage-unavailable')
    return credentials.clear()
  })
}
