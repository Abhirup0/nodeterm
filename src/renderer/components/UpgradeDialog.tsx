import { createPortal } from 'react-dom'
import { useEntitlement } from '../state/entitlement'
import { useUpgradeGate } from '../state/upgradeGate'

/**
 * Pro upgrade prompt shown when a free user triggers a gated feature. Closes automatically
 * once an active entitlement arrives (entitlement onChange flips isPremium).
 */
export function UpgradeDialog() {
  const { open, feature, hide } = useUpgradeGate()
  const isPremium = useEntitlement((s) => s.isPremium)
  const upgrade = useEntitlement((s) => s.upgrade)
  if (!open || isPremium) return null
  return createPortal(
    <div className="confirm-overlay" onClick={hide}>
      <div className="confirm" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">{feature} is a Pro feature</p>
        <p className="confirm__msg">
          Unlock remote SSH terminals and other Pro features. Complete your purchase in the
          browser — Pro unlocks here automatically.
        </p>
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={hide}>
            Maybe later
          </button>
          <button className="confirm__btn primary" autoFocus onClick={() => void upgrade()}>
            Upgrade to Pro — $29/mo
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
