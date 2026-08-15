import { describe, it, expect, afterEach } from 'vitest'
import { agentLaunchOverride, claudeLaunchCommand, createAgentNode } from './workspace'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

/**
 * The launch-command override (Settings → Agents → Launch commands): a wrapper the user launches
 * an agent through — the "I switch accounts with a wrapper script" request. The load-bearing
 * facts pinned here:
 *  - the override replaces the program part of a NEW node's launch line, and every appended
 *    piece (prompt quoting, permission-mode flag, grok's `--` separator) lands exactly where it
 *    does on the bare command;
 *  - an unset/blank override changes nothing, byte-for-byte — the default-path guarantee every
 *    existing user is standing on.
 *
 * `useSettings.setState` (not `update`) on purpose: update() schedules a disk save through
 * `window.nodeTerminal`, which does not exist in this test environment.
 */
const withOverrides = (agentLaunchCommands: Settings['agentLaunchCommands']): void => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentLaunchCommands } })
}

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

const cmd = (agentId: string, prompt?: string): string =>
  (createAgentNode(agentId, 0, undefined, undefined, prompt).data.initialCommand as string) ?? ''

describe('agentLaunchOverride', () => {
  it('is undefined out of the box and for blank values', () => {
    expect(agentLaunchOverride('claude')).toBeUndefined()
    withOverrides({ claude: '   ' })
    expect(agentLaunchOverride('claude')).toBeUndefined()
  })

  it('returns the trimmed override', () => {
    withOverrides({ claude: '  my-claude work  ' })
    expect(agentLaunchOverride('claude')).toBe('my-claude work')
  })

  it('never answers for a custom agent — they own their launchCmd', () => {
    withOverrides({ claude: 'cc' })
    expect(agentLaunchOverride('custom:abc')).toBeUndefined()
  })
})

describe('claudeLaunchCommand', () => {
  it('stays byte-identical to the historical default when unset', () => {
    expect(claudeLaunchCommand()).toBe('claude')
  })

  it('is the override when set — Branch’s `-r <id>` append rides it unchanged', () => {
    withOverrides({ claude: 'my-claude work' })
    expect(claudeLaunchCommand()).toBe('my-claude work')
  })
})

describe('createAgentNode — launch-command override', () => {
  it('launches claude through the wrapper, prompt appended as ever', () => {
    withOverrides({ claude: 'my-claude work' })
    expect(cmd('claude', 'fix the bug')).toBe("my-claude work 'fix the bug'")
  })

  it('keeps grok’s `--` separator after the override', () => {
    withOverrides({ grok: 'grok-wrap' })
    expect(cmd('grok', 'version')).toBe("grok-wrap -- 'version'")
  })

  it('keeps opencode’s --prompt flag after the override', () => {
    withOverrides({ opencode: 'oc-wrap' })
    expect(cmd('opencode', 'hello')).toBe("oc-wrap --prompt 'hello'")
  })

  it('leaves every agent without an override on its bare command', () => {
    withOverrides({ claude: 'my-claude work' })
    expect(cmd('codex', 'hello')).toBe("codex 'hello'")
    expect(cmd('gemini')).toBe('gemini')
  })
})
