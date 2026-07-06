import { useState, type ReactNode } from 'react'
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
  | { type: 'submenu'; label: string; icon?: ReactNode; children: MenuItem[] }

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
  // Index of the row whose submenu flyout is currently open (hover-driven).
  const [openSub, setOpenSub] = useState<number | null>(null)
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
          if (item.type === 'submenu') {
            return (
              <div
                key={i}
                className="ctx-item ctx-item--submenu"
                onMouseEnter={() => setOpenSub(i)}
                onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
              >
                <span className="ctx-icon">{item.icon}</span>
                {item.label}
                {openSub === i && (
                  <div className="ctx-menu ctx-submenu" onClick={(e) => e.stopPropagation()}>
                    {item.children.map((child, j) => {
                      if (child.type === 'separator') return <div key={j} className="ctx-sep" />
                      if (child.type === 'label')
                        return <div key={j} className="ctx-label">{child.label}</div>
                      if (child.type === 'colors' || child.type === 'submenu') return null
                      return (
                        <button
                          key={j}
                          className={`ctx-item${child.danger ? ' danger' : ''}`}
                          disabled={child.disabled}
                          onClick={() => {
                            child.onClick()
                            onClose()
                          }}
                        >
                          <span className="ctx-icon">{child.icon}</span>
                          {child.label}
                        </button>
                      )
                    })}
                  </div>
                )}
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
