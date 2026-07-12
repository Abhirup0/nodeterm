import { describe, it, expect } from 'vitest'
import { tmuxConf } from './pty-manager'

describe('tmuxConf', () => {
  const c = tmuxConf(50000)
  it('leaves the mouse off so drags are xterm\'s own selection', () => {
    expect(c).toContain('set -g mouse off')
    expect(c).not.toContain('set -g mouse on')
  })
  it('binds no mouse keys and no longer shells out to pbcopy', () => {
    expect(c).not.toContain('MouseDragEnd1Pane')
    expect(c).not.toContain('copy-pipe-and-cancel')
    expect(c).not.toContain('pbcopy')
  })
  it('keeps OSC 52 as a safety net for apps that emit it themselves', () => {
    expect(c).toContain('set -g set-clipboard on')
  })
  it('floors history-limit at 1000', () => {
    expect(tmuxConf(10)).toContain('set -g history-limit 1000')
  })
})
