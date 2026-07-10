import { describe, expect, it } from 'vitest'
import { mergeManagedHook } from './install-helper'

const cmd = 'sh "/remote/.nodeterm/agent-hooks/claude.sh"'

describe('mergeManagedHook', () => {
  it('adds the managed command to each event, preserving other tools hooks', () => {
    const out = mergeManagedHook({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }, cmd, ['Stop'])
    expect(out.hooks!.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'other' }] },
      { hooks: [{ type: 'command', command: cmd }] }
    ])
  })
  it('is idempotent — re-merging drops the prior managed entry (agent-hooks marker)', () => {
    const once = mergeManagedHook({}, cmd, ['Stop'])
    const twice = mergeManagedHook(once, cmd, ['Stop'])
    expect(twice.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
  })
  it("leaves another app's agent-hooks entry alone", () => {
    // A foreign hook command can also contain "agent-hooks" — a substring match would delete
    // that tool's hooks the moment we install into an event it also uses (StopFailure).
    const foreign = {
      hooks: [
        {
          type: 'command',
          command:
            "if [ -x '/Users/x/.someapp/agent-hooks/claude-hook.sh' ]; then /bin/sh '/Users/x/.someapp/agent-hooks/claude-hook.sh'; fi"
        }
      ]
    }
    const out = mergeManagedHook({ hooks: { StopFailure: [foreign] } }, cmd, ['StopFailure'])
    expect(out.hooks!.StopFailure).toEqual([foreign, { hooks: [{ type: 'command', command: cmd }] }])
  })
  it('drops a legacy claude-signals managed entry too', () => {
    const out = mergeManagedHook(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh /x/claude-signals.sh' }] }] } },
      cmd,
      ['Stop']
    )
    expect(out.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
  })
})
