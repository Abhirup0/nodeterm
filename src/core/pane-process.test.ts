import { describe, expect, it } from 'vitest'
import { foregroundProcessGroup, parsePaneProcess } from './pane-process'

describe('pane foreground process safety', () => {
  it('parses the tmux pane pid and foreground command', () => {
    expect(parsePaneProcess('33293|codex\n')).toEqual({ panePid: 33293, command: 'codex' })
    expect(parsePaneProcess('bad|codex')).toBeNull()
    expect(parsePaneProcess('33293|')).toBeNull()
  })

  it('accepts only a distinct positive foreground process group', () => {
    const pane = { panePid: 33293, command: 'codex' }
    expect(foregroundProcessGroup(pane, '33319\n')).toBe(33319)
    expect(foregroundProcessGroup(pane, '33293')).toBeNull()
    expect(foregroundProcessGroup(pane, '-1')).toBeNull()
    expect(foregroundProcessGroup(pane, 'not-a-pid')).toBeNull()
  })

  it('never treats a shell-owned pane as an agent to terminate', () => {
    expect(foregroundProcessGroup({ panePid: 33293, command: '-zsh' }, '33319')).toBeNull()
    expect(foregroundProcessGroup({ panePid: 33293, command: '/bin/bash' }, '33319')).toBeNull()
  })
})
