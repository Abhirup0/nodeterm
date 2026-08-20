import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ProjectLaunchInfo } from '@shared/project-settings'
import { agentLaunchOverride, resetLaunchTrustAsksForTests } from './workspace'
import { ensureProjectLaunchInfo, resetProjectLaunchInfoForTests } from './projectLaunchInfo'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

/**
 * LITERAL ONLY, for a PROJECT-sourced launchCmd — the same rule the project's env already obeys
 * (`ProjectSpawnOverrides.env`: "`${env:VAR}` is NOT expanded here"), now enforced on the launch
 * command as well.
 *
 * The hole this pins: `assembleLaunchCommand` → `expandedProgram` expands `${env:VAR}` in whatever
 * `launchCmdOverride` it is handed, while the consent dialog renders the launchCmd VERBATIM. For a
 * git-shared, hand-editable document that difference is a read of this machine's environment
 * laundered past a dialog that showed the token — and there is no honest way to type it either: a
 * literal `${env:X}` is a bad substitution at bash/zsh. So a project launchCmd carrying a token is
 * not a launch command at all, and resolves exactly like the non-string case: the layer below.
 *
 * The GLOBAL launch override (Settings → Agents) and a custom agent's own `launchCmd` are untouched
 * — those are the local user's own typing, previewed with expansion in Settings.
 */

const requestTrust = vi.fn(() => Promise.resolve(false))

/** Seeds the module-level launch-info cache the way Canvas warms it (one wire round trip). */
async function warmProject(projectId: string, info: ProjectLaunchInfo): Promise<void> {
  ;(globalThis as { window?: unknown }).window = {
    nodeTerminal: {
      projectSettings: { launchInfo: () => Promise.resolve(info) },
      projectSetup: { requestTrust }
    }
  }
  await ensureProjectLaunchInfo(projectId)
}

const paired = (cmd: string, source: 'local' | 'shared'): ProjectLaunchInfo => ({
  resolved: {
    setup: {},
    worktree: {},
    agents: {
      defaultAgentId: { value: 'claude', source },
      launchCmd: { value: cmd, source }
    },
    terminal: {}
  },
  trusted: { agents: true, shell: true }
})

const settingsWith = (patch: Partial<Settings>): void => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...patch } })
}

beforeEach(() => {
  resetProjectLaunchInfoForTests()
  resetLaunchTrustAsksForTests()
  requestTrust.mockClear()
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  delete (globalThis as { window?: unknown }).window
})

describe('agentLaunchOverride — a project launchCmd is literal, never ${env:…}-expanded', () => {
  it.each(['local', 'shared'] as const)(
    'refuses a %s launchCmd that references the environment, falling to the global layer',
    async (source) => {
      settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
      await warmProject('p1', paired('${env:HOME}/.evil/claude', source))
      expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
    }
  )

  // The token can sit anywhere in the line — a wrapper with an env-referencing argument reads the
  // environment just as surely as one in the program position.
  it('refuses a token anywhere in the line, not just in the program position', async () => {
    await warmProject('p1', paired('wrapper --token ${env:ANTHROPIC_API_KEY} -- claude', 'shared'))
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
  })

  // Refused BEFORE the trust branch, for the same reason an out-of-scope agent is: a value that can
  // never be consumed must not raise a question about itself.
  it('never asks for trust about an untrusted shared launchCmd it would refuse anyway', async () => {
    const info = paired('${env:HOME}/bin/claude', 'shared')
    info.trusted.agents = false
    await warmProject('p1', info)
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
    expect(requestTrust).not.toHaveBeenCalled()
  })

  // The rule is narrow: an ordinary wrapper — including one carrying a plain shell `$VAR`, which
  // the assembler never touches — is consumed exactly as before.
  it('still consumes an ordinary project launchCmd', async () => {
    await warmProject('p1', paired('nix develop -c claude', 'shared'))
    expect(agentLaunchOverride('claude', 'p1')).toBe('nix develop -c claude')
  })

  it('leaves the GLOBAL launch override free to reference the environment', async () => {
    settingsWith({ agentLaunchCommands: { claude: '${env:HOME}/bin/claude' } })
    expect(agentLaunchOverride('claude', 'p1')).toBe('${env:HOME}/bin/claude')
  })
})
