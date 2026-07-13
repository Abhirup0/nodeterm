// Minimal consent notice for the invite/approve flow. Presentational only — the load-bearing logic
// is the pure describeGrant (src/shared/remote/consent.ts, unit-tested). 4c places this in the actual
// invite/approve dialog. Kept tiny + prop-driven so it needs no store wiring.
import { describeGrant } from '@shared/remote/consent'

export function ConsentNotice({ peerLabel }: { peerLabel: string }): JSX.Element {
  return (
    <p className="remote-consent" role="note">
      {describeGrant(peerLabel)}
    </p>
  )
}
