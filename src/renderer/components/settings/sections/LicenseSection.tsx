import { useState } from 'react'
import { useEntitlement } from '../../../state/entitlement'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  license: {
    title: 'License',
    keywords: ['pro', 'upgrade', 'license', 'key', 'subscription', 'activate']
  }
}
const ENTRIES = Object.values(ROWS)

export function LicenseSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const ent = useEntitlement()
  const [licenseKey, setLicenseKey] = useState('')
  const [upgrading, setUpgrading] = useState(false)
  return (
    <SettingsSection
      id="license"
      title="License"
      description="Manage your nodeterm Pro subscription."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.license}>
        {ent.isPremium ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Pro — active
              {ent.status.expiresAt
                ? ` until ${new Date(ent.status.expiresAt * 1000).toLocaleDateString()}`
                : ''}
              .
            </p>
            <Button onClick={() => void ent.deactivate()}>Deactivate on this device</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Button
              variant="primary"
              onClick={() => {
                setUpgrading(true)
                void ent.upgrade()
              }}
            >
              Upgrade to Pro — $29/mo
            </Button>
            <p className="text-sm text-muted">
              {upgrading
                ? 'Complete your purchase in the browser — Pro unlocks here automatically.'
                : 'Unlock remote access and Pro features.'}
            </p>
            <details>
              <summary className="cursor-pointer text-sm text-muted">Have a license key?</summary>
              <div className="mt-3 space-y-2">
                <FieldRow
                  label="License key"
                  control={
                    <Input
                      className="w-64"
                      placeholder="paste your key"
                      value={licenseKey}
                      onChange={(e) => setLicenseKey(e.target.value)}
                    />
                  }
                />
                <Button
                  onClick={() => {
                    if (licenseKey.trim()) void ent.activate(licenseKey.trim())
                  }}
                >
                  Activate
                </Button>
                {ent.status.error ? (
                  <p className="text-sm" style={{ color: '#ff9f0a' }}>
                    Could not activate ({ent.status.error}).
                  </p>
                ) : null}
              </div>
            </details>
          </div>
        )}
      </SearchableRow>
    </SettingsSection>
  )
}
