import { canSwitchModel, capabilityAgentId, type AgentId } from './config'
import { shellSingleQuote } from '../shell-quote'

/** One Bifrost-compatible gateway configured once for every supported agent harness. */
export interface ModelGatewaySettings {
  /** Gateway root, before Bifrost's `/openai`, `/anthropic`, and `/v1/models` routes. */
  baseUrl: string
  /** Bifrost virtual key (or an upstream-compatible bearer key). */
  apiKey: string
}

/** The intentionally small model shape shared across IPC and renderer state. */
export interface GatewayModel {
  id: string
  name?: string
  provider?: string
}

export interface ModelDiscoveryResult {
  models: GatewayModel[]
  error?: string
}

export interface ModelGatewayRoutes {
  discovery: string
  openai: string
  anthropic: string
}

/**
 * Derive every route from one user-entered root. Only http(s) URLs are accepted: this value is
 * later handed to `fetch` and agent CLIs, and settings.json is hand-editable. Invalid input
 * degrades to null (no discovery and no injected environment), never to a guessed endpoint.
 */
export function modelGatewayRoutes(baseUrl: string): ModelGatewayRoutes | null {
  const raw = baseUrl.trim().replace(/\/+$/, '')
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // Credentials in the URL would be copied into every derived endpoint and surfaced in the UI.
    // The separate API-key field exists precisely so a secret never has to live there.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
    const root = parsed.toString().replace(/\/+$/, '')
    return {
      discovery: `${root}/v1/models`,
      openai: `${root}/openai/v1`,
      anthropic: `${root}/anthropic`
    }
  } catch {
    return null
  }
}

/** Parse OpenAI/Bifrost model-list responses, dropping unsafe/empty/duplicate ids. */
export function parseGatewayModels(payload: unknown): GatewayModel[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const byId = new Map<string, GatewayModel>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { id?: unknown; name?: unknown; provider?: unknown; owned_by?: unknown }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || id.length > 500 || /[\u0000-\u001f\u007f]/.test(id)) continue
    const prefix = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
    const explicitProvider =
      typeof row.provider === 'string'
        ? row.provider.trim()
        : typeof row.owned_by === 'string'
          ? row.owned_by.trim()
          : ''
    byId.set(id, {
      id,
      ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name.trim() } : {}),
      ...(explicitProvider || prefix ? { provider: explicitProvider || prefix } : {})
    })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Models an agent can be offered. Bifrost intentionally routes provider-prefixed models through
 * each harness protocol (including non-Anthropic models through Claude Code's Anthropic route), so
 * filtering by provider here would hide supported modes. The capability is the only UI gate;
 * custom agents inherit it from their declared base harness.
 */
export function modelsForAgent(models: GatewayModel[], agentId: AgentId): GatewayModel[] {
  if (!canSwitchModel(agentId)) return []
  return models
}

/**
 * Environment applied to a terminal session before custom-agent env (custom values still win).
 * Claude/Codex model selection stays a quoted CLI flag. Copilot's BYOK protocol instead carries
 * its internal + wire model ids in environment variables. Credentials never enter a restart
 * command, so none are exposed in the pane.
 */
export function modelGatewayEnv(
  settings: ModelGatewaySettings,
  agentId: AgentId,
  model?: string
): Record<string, string> {
  const routes = modelGatewayRoutes(settings.baseUrl)
  const key = settings.apiKey.trim()
  if (!routes || !key || !canSwitchModel(agentId)) return {}
  switch (capabilityAgentId(agentId)) {
    case 'claude':
      return {
        ANTHROPIC_BASE_URL: routes.anthropic,
        ANTHROPIC_AUTH_TOKEN: key
      }
    case 'codex':
      return {
        OPENAI_BASE_URL: routes.openai,
        OPENAI_API_KEY: key
      }
    case 'copilot': {
      // Copilot's BYOK mode requires a model at startup. Keep an ordinary Copilot node on GitHub's
      // own routing until the user actually selects one; otherwise merely configuring a gateway
      // would activate an incomplete provider and make every new Copilot node fail to launch.
      const wireModel = normalizedAgentModel(agentId, model)
      if (!wireModel) return {}
      const slash = wireModel.indexOf('/')
      const provider = slash > 0 ? wireModel.slice(0, slash).toLowerCase() : ''
      const modelId = slash > 0 ? wireModel.slice(slash + 1) : wireModel
      const anthropic = provider === 'anthropic'
      return {
        COPILOT_PROVIDER_BASE_URL: anthropic ? routes.anthropic : routes.openai,
        COPILOT_PROVIDER_TYPE: anthropic ? 'anthropic' : 'openai',
        COPILOT_PROVIDER_API_KEY: key,
        // Bifrost needs the provider-prefixed wire id; Copilot's internal catalogue wants the
        // unprefixed well-known id for token limits/tool strategy. Its official BYOK grammar
        // explicitly supports separating these two values.
        COPILOT_PROVIDER_MODEL_ID: modelId,
        COPILOT_PROVIDER_WIRE_MODEL: wireModel,
        ...(!anthropic && /^gpt-5(?:[.-]|$)/i.test(modelId)
          ? { COPILOT_PROVIDER_WIRE_API: 'responses' }
          : {})
      }
    }
    default:
      return {}
  }
}

/** Re-validate a hand-editable/discovered model id at the point it reaches a launch command. */
export function normalizedAgentModel(agentId: AgentId, model: string | undefined): string | null {
  const value = model?.trim()
  if (
    !value ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !canSwitchModel(agentId)
  )
    return null
  return value
}

/** Append a safely quoted model flag only for harnesses whose CLI grammar supports it. */
export function withAgentModel(cmd: string, agentId: AgentId, model: string | undefined): string {
  const value = normalizedAgentModel(agentId, model)
  if (!value) return cmd
  // Copilot receives the model through COPILOT_PROVIDER_MODEL_ID/WIRE_MODEL. Appending --model
  // would collapse those two distinct values back together and send the unrecognized
  // provider-prefixed Bifrost id through Copilot's internal catalogue.
  if (capabilityAgentId(agentId) === 'copilot') return cmd
  return `${cmd} --model ${shellSingleQuote(value)}`
}
