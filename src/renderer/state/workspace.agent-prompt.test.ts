import { describe, expect, it } from 'vitest'
import { createAgentNode } from './workspace'

/**
 * The separator is the whole reason `argvPromptSeparator` exists, and it is invisible in the config
 * unless the command that comes out is pinned: grok's usage is `grok [OPTIONS] [PROMPT] [COMMAND]`,
 * so a one-word prompt collides with a subcommand. Measured on the shipped binary, `grok version`
 * prints the version and exits while `grok -- version` asks the model about "version".
 */
describe('createAgentNode — the argv prompt separator', () => {
  const cmd = (agentId: string, prompt?: string): string =>
    (createAgentNode(agentId, 0, undefined, undefined, prompt).data.initialCommand as string) ?? ''

  it('puts `--` between grok and its prompt', () => {
    expect(cmd('grok', 'explain this repo')).toBe("grok -- 'explain this repo'")
  })

  it('protects a prompt that is also a subcommand name — the case it exists for', () => {
    expect(cmd('grok', 'version')).toBe("grok -- 'version'")
  })

  it('leaves grok bare when there is no prompt (no dangling separator)', () => {
    expect(cmd('grok')).toBe('grok')
  })

  it('does NOT add a separator for the other agents', () => {
    // claude's command line has to stay byte-identical to what it has always been.
    expect(cmd('claude', 'hello')).toContain("claude 'hello'")
    expect(cmd('claude', 'hello')).not.toContain('--')
  })
})
