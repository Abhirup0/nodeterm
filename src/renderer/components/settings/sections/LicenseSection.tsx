import { useEffect, useState } from 'react'
import { useEntitlement } from '../../../state/entitlement'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ProCompare } from './ProCompare'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { licenseSentence, canReleaseDevices } from '@renderer/lib/licenseCopy'

const ROWS = {
  license: {
    title: 'License',
    keywords: [
      'pro',
      'upgrade',
      'license',
      'key',
      'subscription',
      'activate',
      'compare',
      'core',
      'remote access',
      'quota',
      'devices',
      'seats',
      'release',
      'copy key'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

export function LicenseSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const ent = useEntitlement()
  const [licenseKey, setLicenseKey] = useState('')
  const [upgrading, setUpgrading] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [releaseFailed, setReleaseFailed] = useState(false)
  // `loadDetail` REJECTS on the Server Edition (`E_UNSUPPORTED` — there is no license layer in
  // src/server), and the store deliberately does not swallow it. Catching here is not optional:
  // uncaught, this is an unhandled rejection on every browser session. And what we show there is
  // NOTHING — a read that could not run is not "no key, 0 devices".
  const [detailUnavailable, setDetailUnavailable] = useState(false)
  useEffect(() => {
    if (!ent.isPremium) return
    void ent.loadDetail().catch(() => setDetailUnavailable(true))
    // `ent.loadDetail` is a stable zustand action; the entitlement becoming premium is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ent.isPremium])

  const detail = detailUnavailable ? null : ent.detail
  const sentence = licenseSentence(detail)
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
            <ProCompare />
            <p className="text-sm text-muted">
              Pro — active
              {ent.status.expiresAt
                ? ` until ${new Date(ent.status.expiresAt * 1000).toLocaleDateString()}`
                : ''}
              .
            </p>
            {detail ? (
              <>
                <FieldRow
                  label="License key"
                  control={
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-64"
                        readOnly
                        value={detail.key ?? ''}
                        placeholder={detail.key ? undefined : 'not available'}
                      />
                      <Button
                        disabled={!detail.key}
                        onClick={() => {
                          if (detail.key) void navigator.clipboard.writeText(detail.key)
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                  }
                />
                {sentence ? <p className="text-sm text-muted">{sentence}</p> : null}
                {detail.key ? (
                  <p className="text-sm text-muted">
                    To use Pro on another Mac, open Settings → License there and paste this key.
                  </p>
                ) : null}
                {canReleaseDevices(detail) ? (
                  <div className="space-y-2">
                    <Button
                      disabled={releasing}
                      onClick={() => {
                        setReleasing(true)
                        setReleaseFailed(false)
                        void ent
                          .releaseOthers()
                          // Same uncaught-rejection rule as `loadDetail` above — plus an ordinary
                          // IPC failure here would otherwise leave the button stuck on "Releasing…".
                          .catch(() => setReleaseFailed(true))
                          .finally(() => setReleasing(false))
                      }}
                    >
                      {releasing ? 'Releasing…' : 'Release other devices'}
                    </Button>
                    {releaseFailed ? (
                      <p className="text-sm" style={{ color: '#ff9f0a' }}>
                        Could not release the other devices. Nothing was changed.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            <Button onClick={() => void ent.deactivate()}>Deactivate on this device</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <ProCompare />
            <Button
              variant="primary"
              onClick={() => {
                setUpgrading(true)
                void ent.upgrade()
              }}
            >
              Upgrade to Pro — $10/mo
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
