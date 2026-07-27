import { describe, expect, it } from 'vitest'
import { buildManagedHookCommand, mergeManagedHook } from './install-helper'

const cmd = buildManagedHookCommand('/remote/.nodeterm/agent-hooks/claude.sh')

describe('buildManagedHookCommand', () => {
  it('runs the script only when it is still readable, and exits 0 otherwise', () => {
    // The whole point: a stale entry (uninstalled app, cleared data dir, a server --data-dir
    // under a temp path) must not exit non-zero — that BLOCKS every UserPromptSubmit.
    expect(cmd).toBe(
      "if [ -r '/remote/.nodeterm/agent-hooks/claude.sh' ]; then sh '/remote/.nodeterm/agent-hooks/claude.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })
  it("single-quote escapes the path so a quote or $ in it can't break out", () => {
    expect(buildManagedHookCommand("/a'b/$x/agent-hooks/claude.sh")).toContain(
      "'/a'\\''b/$x/agent-hooks/claude.sh'"
    )
  })
  it('still carries the marker that makes the entry ours', () => {
    const out = mergeManagedHook({}, cmd, ['Stop'])
    expect(mergeManagedHook(out, cmd, ['Stop']).hooks!.Stop).toHaveLength(1)
  })
  it('replaces the pre-guard `sh "<path>"` entry from an older install', () => {
    const legacy = { hooks: [{ type: 'command', command: 'sh "/old/data/agent-hooks/claude.sh"' }] }
    const out = mergeManagedHook({ hooks: { UserPromptSubmit: [legacy] } }, cmd, ['UserPromptSubmit'])
    expect(out.hooks!.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
  })
})

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
