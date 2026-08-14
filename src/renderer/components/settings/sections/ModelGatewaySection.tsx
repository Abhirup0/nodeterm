import { useState } from 'react'
import { modelGatewayRoutes } from '@shared/agents/model-gateway'
import { useModelGateway } from '../../../state/modelGateway'
import { useSettings } from '../../../state/settings'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { FieldRow } from '../FieldRow'
import { SearchableRow } from '../SearchableRow'
import { SettingsSection } from '../SettingsSection'

const ROWS = {
  endpoint: {
    title: 'Gateway URL',
    description: 'One Bifrost-compatible root URL for model discovery and agent routes.',
    keywords: ['bifrost', 'model', 'provider', 'base url', 'endpoint']
  },
  key: {
    title: 'API key',
    description: 'A Bifrost virtual key or compatible bearer key.',
    keywords: ['token', 'secret', 'virtual key', 'authentication']
  },
  discovery: {
    title: 'Available models',
    description: 'Refresh the model catalogue used by agent-node context menus.',
    keywords: ['discover', 'refresh', 'switch model', 'catalogue']
  }
}
const ENTRIES = Object.values(ROWS)

export function ModelGatewaySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const gateway = useSettings((s) => s.settings.modelGateway)
  const update = useSettings((s) => s.update)
  const models = useModelGateway((s) => s.models)
  const status = useModelGateway((s) => s.status)
  const error = useModelGateway((s) => s.error)
  const discover = useModelGateway((s) => s.discover)
  const [showKey, setShowKey] = useState(false)
  const routes = modelGatewayRoutes(gateway.baseUrl)

  const patchGateway = (patch: Partial<typeof gateway>): void =>
    update({ modelGateway: { ...gateway, ...patch } })

  return (
    <SettingsSection
      id="model-gateway"
      title="Model gateway"
      description="Configure one Bifrost-compatible endpoint, discover its models, and switch a supported agent node without creating a custom agent for every model."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.endpoint}>
        <FieldRow
          label="Gateway URL"
          description="Enter the server root; nodeterm derives /v1/models, /openai/v1, and /anthropic."
          htmlFor="model-gateway-url"
          control={
            <Input
              id="model-gateway-url"
              className="w-80"
              type="url"
              placeholder="https://bifrost.example.com"
              value={gateway.baseUrl}
              onChange={(e) => patchGateway({ baseUrl: e.target.value })}
            />
          }
        />
        {gateway.baseUrl && !routes ? (
          <p className="mt-2 text-right text-xs text-[color:var(--warn)]">
            Enter a valid HTTP(S) URL without embedded credentials.
          </p>
        ) : routes ? (
          <div className="mt-3 space-y-1 text-right font-mono text-[11px] text-muted">
            <div>Discovery: {routes.discovery}</div>
            <div>OpenAI: {routes.openai}</div>
            <div>Anthropic: {routes.anthropic}</div>
          </div>
        ) : null}
      </SearchableRow>

      <SearchableRow {...ROWS.key}>
        <FieldRow
          label="API key"
          description="Saved locally in the owner-only settings file and never placed in restart commands."
          htmlFor="model-gateway-key"
          control={
            <div className="flex items-center gap-2">
              <Input
                id="model-gateway-key"
                className="w-64"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                placeholder="virtual key"
                value={gateway.apiKey}
                onChange={(e) => patchGateway({ apiKey: e.target.value })}
              />
              <Button onClick={() => setShowKey((value) => !value)}>
                {showKey ? 'Hide' : 'Show'}
              </Button>
            </div>
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.discovery}>
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-text">Available models</div>
            <p className="mt-1 text-[13px] text-muted">
              {status === 'loading'
                ? 'Discovering models…'
                : status === 'ready'
                  ? `${models.length} model${models.length === 1 ? '' : 's'} available.`
                  : 'Models are also refreshed automatically when these settings change.'}
            </p>
            {error ? <p className="mt-1 text-xs text-[color:var(--warn)]">{error}</p> : null}
          </div>
          <Button
            disabled={!routes || !gateway.apiKey.trim() || status === 'loading'}
            onClick={() => void discover(gateway)}
          >
            {status === 'loading' ? 'Discovering…' : models.length ? 'Refresh' : 'Discover models'}
          </Button>
        </div>
        {models.length ? (
          <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-black/15 px-3 py-2 font-mono text-[11px] text-muted">
            {models.map((model) => (
              <div key={model.id}>{model.id}</div>
            ))}
          </div>
        ) : null}
      </SearchableRow>
    </SettingsSection>
  )
}
