import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { isHoldChord, shortcutKeyParts } from '@shared/shortcut'
import type { CommandId } from '@shared/keybindings'
import { isBrowserRuntime } from '../bridge/runtime'
import { commandKeys } from '../lib/keybindingOverrides'
import { useSettings } from '../state/settings'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)
import { keyLabel } from '@shared/platform-utils'

export interface ShortcutsPanelProps {
  onClose: () => void
}

interface Row {
  keys: string[]
  label: string
}

/** Registry rows derive their keys from the effective binding, so a remap in settings.json
 *  shows up here without touching this file — and a command the user unbound (or that ships
 *  unassigned) drops off the panel instead of advertising a chord that no longer fires.
 *  Gesture/mouse rows stay literal: they are not commands and the registry knows nothing
 *  about them. "Dictate" also stays literal — its chord still lives in
 *  `settings.speech.shortcut` (the registry's `speech.dictation` row is display-only for now),
 *  and a modifier-only chord is hold-to-talk, which the label spells out. */
function buildSections(dictationKeys: string[], dictationLabel: string): { title: string; rows: Row[] }[] {
  const cmd = (id: CommandId, label: string): Row[] => {
    const keys = commandKeys(id)
    return keys.length ? [{ keys, label }] : []
  }
  return [
    {
      title: 'General',
      rows: [
        ...cmd('app.commandPalette', 'Command palette'),
        ...cmd('app.settings', 'Settings'),
        ...cmd('app.shortcutsPanel', 'This shortcuts panel'),
        ...cmd('panel.explorer', 'Explorer'),
        ...cmd('panel.sourceControl', 'Source Control'),
        ...cmd('view.kanbanToggle', 'Kanban board'),
        ...cmd('panel.sessions', 'Pin the sessions sidebar'),
        // Desktop only: browsers own Cmd/Ctrl+1-9 for tab switching and a page cannot take it
        // back, so listing it in the Server Edition would promise a shortcut that never fires.
        ...(isBrowserRuntime() ? [] : [{ keys: ['⌘', '1-9'], label: 'Jump to project' }]),
        { keys: dictationKeys, label: dictationLabel },
        ...cmd('canvas.undo', 'Undo'),
        ...cmd('canvas.redo', 'Redo')
      ]
    },
    {
      title: 'Canvas',
      rows: [
        ...cmd('node.newTerminal', 'New terminal'),
        ...cmd('node.newAgent', 'New Claude Code'),
        ...cmd('node.close', 'Close selected node'),
        ...cmd('canvas.deleteSelection', 'Delete selection'),
        { keys: ['Right-click'], label: 'Actions menu (empty space or node)' },
        { keys: ['Left-drag'], label: 'Box-select (touch to select)' },
        { keys: ['Middle / Right-drag'], label: 'Pan the canvas' },
        { keys: ['Double-click'], label: 'Center & focus a node' },
        { keys: ['⌘', 'wheel'], label: 'Zoom in / out' },
        // Advertised on BOTH surfaces, unlike "Jump to project" above. ⌘1-9 is dropped there
        // because the browser RESERVES it (tab switching, un-preventable) for something unrelated;
        // ⌘0 is neither — it is not in the reserved set, so the page gets the keydown, and even
        // where a browser insists on handling it too it means the same thing we do ("actual size")
        // instead of fighting us. Shift+1 is nobody else's key on any surface.
        { keys: ['⌘', '0'], label: 'Zoom to 100%' },
        { keys: ['⇧', '1'], label: 'Fit view' }
      ]
    },
    {
      title: 'Terminal',
      rows: [
        { keys: ['Hover ~0.6s'], label: 'Enter the terminal (type/select)' },
        { keys: ['Quick drag'], label: 'Move the terminal (before it focuses)' },
        ...cmd('node.toggleMarkdown', 'Toggle markdown view'),
        ...cmd('terminal.find', 'Find in terminal'),
        { keys: ['⌘', 'C'], label: 'Copy selection (markdown view)' },
        { keys: ['✦'], label: 'Name the terminal with AI' }
      ]
    },
    {
      title: 'Source Control',
      rows: [
        ...cmd('panel.sourceControl', 'Open Source Control'),
        ...cmd('scm.commit', 'Commit the staged changes')
      ]
    }
  ]
}

/** Keyboard shortcuts reference; shown on first launch and via ⌘/ or the ? button. */
export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
  const speechShortcut = useSettings((s) => s.settings.speech.shortcut)
  const SECTIONS = buildSections(
    shortcutKeyParts(speechShortcut, isMac),
    isHoldChord(speechShortcut) ? 'Dictate (hold)' : 'Dictate'
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="sc-overlay" onClick={onClose}>
      <div className="shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts__head">
          <h2>Keyboard shortcuts</h2>
          <button className="drawer__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="shortcuts__body">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.rows.map((r) => (
                <div key={r.label} className="shortcut-row">
                  <span className="shortcut-label">{r.label}</span>
                  <span className="shortcut-keys">
                    {r.keys.map((k, i) => (
                      <kbd key={i} className="kbd">
                        {keyLabel(k)}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
