import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NODE_COLORS } from '../state/workspace'

export type MenuItem =
  | {
      type?: 'item'
      label: string
      onClick: () => void
      icon?: ReactNode
      danger?: boolean
      disabled?: boolean
    }
  | { type: 'separator' }
  | { type: 'label'; label: string }
  | { type: 'colors'; onPick: (color: string) => void }

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /**
   * Override the base stacking order. The default CSS z-index (46) sits BELOW drawer
   * overlays (z-index 55), so a ContextMenu opened from inside a drawer (e.g. the Source
   * Control panel) would render hidden behind it. Pass a value above the host overlay.
   */
  zIndex?: number
}

/**
 * A right-click menu rendered in a body portal at fixed coordinates, so it is never
 * clipped or hidden behind the canvas. Closes on backdrop click.
 */
export function ContextMenu({ x, y, items, onClose, zIndex }: ContextMenuProps) {
  // Keep the menu one above its backdrop (matches the default 46/45 CSS ordering).
  const backdropStyle = zIndex != null ? { zIndex } : undefined
  const menuStyle = zIndex != null ? { top: y, left: x, zIndex: zIndex + 1 } : { top: y, left: x }
  return createPortal(
    <>
      <div
        className="ctx-backdrop"
        style={backdropStyle}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onClose}
      />
      <div className="ctx-menu" style={menuStyle} onClick={(e) => e.stopPropagation()}>
        {items.map((item, i) => {
          if (item.type === 'separator') return <div key={i} className="ctx-sep" />
          if (item.type === 'label') return <div key={i} className="ctx-label">{item.label}</div>
          if (item.type === 'colors') {
            return (
              <div key={i} className="ctx-colors">
                {NODE_COLORS.map((c) => (
                  <button
                    key={c}
                    style={{ background: c }}
                    onClick={() => {
                      item.onPick(c)
                      onClose()
                    }}
                  />
                ))}
              </div>
            )
          }
          return (
            <button
              key={i}
              className={`ctx-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                item.onClick()
                onClose()
              }}
            >
              <span className="ctx-icon">{item.icon}</span>
              {item.label}
            </button>
          )
        })}
      </div>
    </>,
    document.body
  )
}
