import { useState } from 'react'
import { Button } from '@renderer/ui/Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { useSettings } from '../../state/settings'
import { isPristine, resetPatch } from '@renderer/lib/settingsReset'
import type { Settings } from '@shared/types'

/**
 * "Reset to defaults" for the settings ONE section owns.
 *
 * Disabled while everything is already at its default — which does two jobs: it keeps a
 * destructive control from firing for nothing, and it answers the question that brought the user
 * here ("have I actually changed anything?"), otherwise unanswerable without remembering what the
 * defaults were.
 */
export function SectionReset<K extends keyof Settings>({
  keys,
  label,
  what
}: {
  keys: readonly K[]
  /** Button text, e.g. "Reset terminal appearance". */
  label: string
  /** Completes the confirm sentence: "Reset <what> to their defaults?" */
  what: string
}): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [asking, setAsking] = useState(false)
  const pristine = isPristine(keys, settings)

  return (
    <>
      <div className="flex items-center justify-between gap-6">
        <p className="text-[13px] leading-relaxed text-muted">
          {pristine
            ? `${what[0].toUpperCase()}${what.slice(1)} are at their defaults.`
            : `Put ${what} back the way they shipped. Nothing else is touched.`}
        </p>
        <Button disabled={pristine} onClick={() => setAsking(true)}>
          {label}
        </Button>
      </div>
      {asking && (
        <ConfirmDialog
          message={`Reset ${what} to their defaults?`}
          confirmLabel="Reset"
          onConfirm={() => {
            update(resetPatch(keys))
            setAsking(false)
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  )
}
