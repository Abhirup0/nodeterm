import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ProjectLaunchInfo } from '@shared/project-settings'
import {
  agentLaunchOverride,
  claudeLaunchCommand,
  createAgentNode,
  resolveNewNodeAgent,
  resetLaunchTrustAsksForTests
} from './workspace'
import { ensureProjectLaunchInfo, resetProjectLaunchInfoForTests } from './projectLaunchInfo'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

/**
 * The PER-PROJECT half of the launch layering (`.nodeterm/settings.json` → `agents`):
 *  - `launchCmd` — this project's local doc, then its git-SHARED doc but ONLY once that family is
 *    trusted, then the user's global Settings → Agents override. Scoped to the agent THIS PROJECT
 *    names as its default and to no other — never the user's global default, which would let a doc
 *    shipping only a launchCmd follow a mutable local preference into a foreign agent's node. An
 *    unpaired launchCmd is inert: consumed by nothing, prompting for nothing.
 *  - `defaultAgentId` — what a NON-explicit new node launches, above the global default.
 * A launch never blocks and never fails closed: no warm snapshot ⇒ byte-identical to before.
 */

const requestTrust = vi.fn(() => Promise.resolve(false))

/** Seeds the module-level launch-info cache the way Canvas warms it (one wire round trip). */
async function warmProject(projectId: string, info: ProjectLaunchInfo | null): Promise<void> {
  ;(globalThis as { window?: unknown }).window = {
    nodeTerminal: {
      projectSettings: { launchInfo: () => Promise.resolve(info) },
      projectSetup: { requestTrust }
    }
  }
  await ensureProjectLaunchInfo(projectId)
}

const info = (
  agents: ProjectLaunchInfo['resolved']['agents'],
  trustedAgents: boolean
): ProjectLaunchInfo => ({
  resolved: { setup: {}, worktree: {}, agents, terminal: {} },
  trusted: { agents: trustedAgents, shell: true }
})

const settingsWith = (patch: Partial<Settings>): void => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...patch } })
}

/** The PAIRED shape a consumable launchCmd needs: the project names its own default agent, and the
 *  launch command is about that agent. `def` defaults to claude — the agent these tests launch. */
const paired = (
  cmd: unknown,
  source: 'local' | 'shared',
  def: unknown = 'claude'
): ProjectLaunchInfo['resolved']['agents'] => ({
  defaultAgentId: { value: def as string, source },
  launchCmd: { value: cmd as string, source }
})

beforeEach(() => {
  resetProjectLaunchInfoForTests()
  resetLaunchTrustAsksForTests()
  requestTrust.mockClear()
  requestTrust.mockImplementation(() => Promise.resolve(false))
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  delete (globalThis as { window?: unknown }).window
})

describe('agentLaunchOverride — per-project launchCmd', () => {
  it('is the global override when no project is named', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired('proj-wrap', 'local'), true))
    expect(agentLaunchOverride('claude')).toBe('global-wrap')
  })

  it('is the global override when the project has no warm snapshot', () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
  })

  it('lets a project LOCAL launchCmd win over the global override', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired('local-wrap', 'local'), false))
    expect(agentLaunchOverride('claude', 'p1')).toBe('local-wrap')
    // A local value is the user's own typing — never gated, so nothing is ever asked.
    expect(requestTrust).not.toHaveBeenCalled()
  })

  it('lets a TRUSTED shared launchCmd win over the global override', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired('shared-wrap', 'shared'), true))
    expect(agentLaunchOverride('claude', 'p1')).toBe('shared-wrap')
    expect(requestTrust).not.toHaveBeenCalled()
  })

  it('falls PAST an untrusted shared launchCmd to the global override', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired('shared-wrap', 'shared'), false))
    expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
  })

  it('falls through to the bare command when there is no global override either', async () => {
    await warmProject('p1', info(paired('shared-wrap', 'shared'), false))
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
    expect(claudeLaunchCommand('p1')).toBe('claude')
  })

  it('asks for trust exactly ONCE per project per session, however many launches ask', async () => {
    await warmProject('p1', info(paired('shared-wrap', 'shared'), false))
    agentLaunchOverride('claude', 'p1')
    agentLaunchOverride('claude', 'p1')
    agentLaunchOverride('claude', 'p1')
    expect(requestTrust).toHaveBeenCalledTimes(1)
    expect(requestTrust).toHaveBeenCalledWith('p1', 'agents')
  })

  it('survives a requestTrust that REJECTS — the launch line is still resolved', async () => {
    requestTrust.mockImplementation(() => Promise.reject(new Error('no handler')))
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired('shared-wrap', 'shared'), false))
    expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
    await Promise.resolve()
  })

  it('never asks for trust when the project sets no shared launchCmd at all', async () => {
    await warmProject('p1', info({}, false))
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
    expect(requestTrust).not.toHaveBeenCalled()
  })

  it('applies only to the agent the project targets — another agent keeps the global path', async () => {
    settingsWith({ agentLaunchCommands: { codex: 'global-codex' }, defaultAgent: 'claude' })
    await warmProject('p1', info(paired('proj-wrap', 'local'), true))
    expect(agentLaunchOverride('claude', 'p1')).toBe('proj-wrap')
    expect(agentLaunchOverride('codex', 'p1')).toBe('global-codex')
  })

  it('follows the project’s own defaultAgentId when deciding which agent it targets', async () => {
    settingsWith({ defaultAgent: 'claude' })
    await warmProject('p1', info(paired('proj-wrap', 'local', 'codex'), true))
    expect(agentLaunchOverride('codex', 'p1')).toBe('proj-wrap')
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
  })

  it('does not ask for trust when the shared launchCmd targets another agent', async () => {
    settingsWith({ defaultAgent: 'claude' })
    await warmProject('p1', info(paired('shared-wrap', 'shared'), false))
    expect(agentLaunchOverride('codex', 'p1')).toBeUndefined()
    expect(requestTrust).not.toHaveBeenCalled()
  })

  it('ignores a blank project launchCmd (and asks nothing for it)', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired('   ', 'shared'), false))
    expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
    expect(requestTrust).not.toHaveBeenCalled()
  })

  it('ignores a non-string launchCmd from a hostile shared document', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' } })
    await warmProject('p1', info(paired(42, 'shared'), true))
    expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
  })
})

/**
 * The UNPAIRED case, and the reason the scope comparison is the project's OWN defaultAgentId and
 * never `resolveNewNodeAgent`'s global fallback: a doc that ships a launchCmd alone would otherwise
 * chase whatever this machine's global default agent happens to be — a different agent per
 * teammate, and a different one again after the local user changes an unrelated Setting.
 */
describe('agentLaunchOverride — an UNPAIRED launchCmd is inert', () => {
  const unpaired = (source: 'local' | 'shared'): ProjectLaunchInfo['resolved']['agents'] => ({
    launchCmd: { value: 'nix develop -c claude', source }
  })

  it.each(['claude', 'codex', 'gemini', 'custom:x'] as const)(
    'is never consumed for %s when the project names no default agent of its own',
    async (agentId) => {
      // Every one of these is this machine's global default in turn — the value that must NOT
      // decide what a shared launch command applies to.
      settingsWith({
        defaultAgent: agentId,
        customAgents: [{ id: 'custom:x', label: 'X', launchCmd: 'x-cli' }] as Settings['customAgents']
      })
      await warmProject('p1', info(unpaired('shared'), true))
      expect(agentLaunchOverride(agentId, 'p1')).toBeUndefined()
    }
  )

  it('never prompts for trust on an untrusted shared launchCmd nobody can consume', async () => {
    settingsWith({ defaultAgent: 'claude' })
    await warmProject('p1', info(unpaired('shared'), false))
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
    expect(requestTrust).not.toHaveBeenCalled()
  })

  it('is inert for a LOCAL launchCmd too — the pairing rule is about meaning, not provenance', async () => {
    settingsWith({ agentLaunchCommands: { claude: 'global-wrap' }, defaultAgent: 'claude' })
    await warmProject('p1', info(unpaired('local'), true))
    expect(agentLaunchOverride('claude', 'p1')).toBe('global-wrap')
  })

  it('is inert when the project names a default agent this machine cannot launch', async () => {
    settingsWith({ defaultAgent: 'claude' })
    await warmProject('p1', info(paired('proj-wrap', 'shared', 'custom:gone'), true))
    expect(agentLaunchOverride('claude', 'p1')).toBeUndefined()
    expect(agentLaunchOverride('custom:gone', 'p1')).toBeUndefined()
    expect(requestTrust).not.toHaveBeenCalled()
  })
})

describe('createAgentNode — the project launch command reaches the typed line', () => {
  it('launches the project’s default agent through the project wrapper', async () => {
    await warmProject('p1', info(paired('proj-wrap', 'local'), true))
    const node = createAgentNode(
      'claude',
      0,
      undefined,
      undefined,
      'fix the bug',
      undefined,
      undefined,
      undefined,
      'p1'
    )
    expect(node.data.initialCommand).toBe("proj-wrap 'fix the bug'")
  })

  it('stays byte-identical to today when no project id is threaded', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, 'fix the bug')
    expect(node.data.initialCommand).toBe("claude 'fix the bug'")
  })
})

describe('resolveNewNodeAgent', () => {
  const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch })

  it('never overrules an explicit pick', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: 'codex', source: 'local' } }, true))
    expect(resolveNewNodeAgent('gemini', 'p1', settings({ defaultAgent: 'claude' }))).toBe('gemini')
  })

  it('uses the project default above the global one', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: 'codex', source: 'local' } }, true))
    expect(resolveNewNodeAgent(undefined, 'p1', settings({ defaultAgent: 'claude' }))).toBe('codex')
  })

  it('accepts a shared project default without a trust grant (naming is not executing)', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: 'codex', source: 'shared' } }, false))
    expect(resolveNewNodeAgent(undefined, 'p1', settings({ defaultAgent: 'claude' }))).toBe('codex')
  })

  it('accepts a custom agent the user actually has', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: 'custom:x', source: 'local' } }, true))
    const s = settings({
      defaultAgent: 'claude',
      customAgents: [{ id: 'custom:x', label: 'X', launchCmd: 'x-cli' }] as Settings['customAgents']
    })
    expect(resolveNewNodeAgent(undefined, 'p1', s)).toBe('custom:x')
  })

  it('falls through when the project names an agent that does not exist', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: 'custom:gone', source: 'local' } }, true))
    expect(resolveNewNodeAgent(undefined, 'p1', settings({ defaultAgent: 'claude' }))).toBe('claude')
  })

  it('falls through when the project names an agent the user has DISABLED', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: 'codex', source: 'shared' } }, true))
    const s = settings({ defaultAgent: 'claude', disabledAgents: ['codex'] })
    expect(resolveNewNodeAgent(undefined, 'p1', s)).toBe('claude')
  })

  it('falls through on a non-string / blank id from a hostile document', async () => {
    await warmProject('p1', info({ defaultAgentId: { value: '  ', source: 'shared' } }, true))
    expect(resolveNewNodeAgent(undefined, 'p1', settings({ defaultAgent: 'claude' }))).toBe('claude')
  })

  it('is the global default when there is no project (or no snapshot)', () => {
    expect(resolveNewNodeAgent(undefined, undefined, settings({ defaultAgent: 'gemini' }))).toBe('gemini')
    expect(resolveNewNodeAgent(undefined, 'cold', settings({ defaultAgent: 'gemini' }))).toBe('gemini')
  })

  it('guards a global default whose custom agent was since removed', () => {
    expect(
      resolveNewNodeAgent(undefined, undefined, settings({ defaultAgent: 'custom:gone' }))
    ).toBe('claude')
  })
})
