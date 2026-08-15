import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { COPILOT_HOOK_EVENTS } from '@shared/agents/hook-events'

let home = ''

vi.mock('os', async (orig) => {
  const real = (await orig()) as typeof import('os')
  return {
    ...real,
    default: { ...real, homedir: () => home },
    homedir: () => home
  }
})

describe('copilot hook installer', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nt-copilot-home-'))
    delete process.env.COPILOT_HOME
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.COPILOT_HOME
    vi.resetModules()
  })

  it("writes Copilot's native hook-file shape and the shared managed script", async () => {
    const { copilotHookConfigPath, installCopilotHooks } =
      await import('./copilot')
    installCopilotHooks()
    expect(copilotHookConfigPath()).toBe(
      path.join(home, '.copilot', 'hooks', 'nodeterm-status.json')
    )
    const cfg = JSON.parse(readFileSync(copilotHookConfigPath(), 'utf8'))
    expect(Object.keys(cfg.hooks).sort()).toEqual(
      [...COPILOT_HOOK_EVENTS].sort()
    )
    expect(cfg.hooks.SessionStart).toEqual([
      {
        type: 'command',
        bash: expect.stringContaining(
          path.join(home, '.nodeterm', 'agent-hooks', 'copilot.sh')
        ),
        timeoutSec: 5
      }
    ])
    expect(cfg.hooks.SessionStart[0].bash).toMatch(/^if \[ -r /)
    expect(cfg.hooks.SessionStart[0].matcher).toBeUndefined()
    expect(cfg.hooks.Notification[0].matcher).toBe(
      'permission_prompt|elicitation_dialog'
    )
    expect(
      readFileSync(
        path.join(home, '.nodeterm', 'agent-hooks', 'copilot.sh'),
        'utf8'
      )
    ).toContain('/hook/copilot')
  })

  it('honors COPILOT_HOME and is idempotent because nodeterm owns its file', async () => {
    process.env.COPILOT_HOME = path.join(home, 'custom-copilot')
    const { copilotHookConfigPath, installCopilotHooks } =
      await import('./copilot')
    installCopilotHooks()
    installCopilotHooks()
    expect(copilotHookConfigPath()).toBe(
      path.join(home, 'custom-copilot', 'hooks', 'nodeterm-status.json')
    )
    const cfg = JSON.parse(readFileSync(copilotHookConfigPath(), 'utf8'))
    for (const entries of Object.values(cfg.hooks) as unknown[][])
      expect(entries).toHaveLength(1)
  })

  it('accepts only absolute, shell-safe remote COPILOT_HOME values', async () => {
    const { isSafeRemoteCopilotHome } = await import('./copilot')
    expect(isSafeRemoteCopilotHome('/opt/copilot home')).toBe(true)
    for (const value of [
      'relative/path',
      ' /opt/copilot',
      '/bad\\path',
      '/bad\npath',
      ''
    ]) {
      expect(isSafeRemoteCopilotHome(value), JSON.stringify(value)).toBe(false)
    }
  })

  it('remove disables every managed subscription without touching another hook file', async () => {
    const { copilotHookConfigPath, installCopilotHooks, removeCopilotHooks } =
      await import('./copilot')
    installCopilotHooks()
    removeCopilotHooks()
    expect(JSON.parse(readFileSync(copilotHookConfigPath(), 'utf8'))).toEqual({
      version: 1,
      hooks: {}
    })
  })
})
