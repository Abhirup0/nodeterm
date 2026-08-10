import { describe, expect, it } from 'vitest'
import { createAgentNode } from './workspace'
import type { AgentPermissionMode } from '@shared/agents/config'

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

/**
 * The separator and the permission-mode flag interact, and pinning each one alone does not catch it:
 * `withPermissionMode` appends LAST, and `--` means END OF OPTIONS. Appended last, the flag lands
 * after the separator and is a POSITIONAL — either swallowed into the prompt text (the setting
 * silently does nothing) or rejected by clap as an unexpected argument (the launch dies on a usage
 * message). So the flag must precede the separator, matching grok's `grok [OPTIONS] [PROMPT]
 * [COMMAND]`. Asserted on the COMPOSED command, one layer below `withPermissionMode` itself, which
 * is where the two rules actually meet.
 */
describe('createAgentNode — permission mode meets the argv separator', () => {
  const cmd = (agentId: string, prompt?: string, mode?: AgentPermissionMode): string =>
    (createAgentNode(agentId, 0, undefined, undefined, prompt, undefined, undefined, mode).data
      .initialCommand as string) ?? ''

  it('puts the flag BEFORE grok\'s `--`, never after it', () => {
    expect(cmd('grok', 'explain this repo', 'plan')).toBe(
      "grok --permission-mode plan -- 'explain this repo'"
    )
    expect(cmd('grok', 'version', 'auto')).toBe("grok --permission-mode auto -- 'version'")
  })

  it('flags a prompt-less grok launch exactly as before (no dangling separator)', () => {
    expect(cmd('grok', undefined, 'plan')).toBe('grok --permission-mode plan')
  })

  it('emits no separator and no flag in manual mode', () => {
    expect(cmd('grok', 'explain this repo', 'manual')).toBe("grok -- 'explain this repo'")
    expect(cmd('grok', undefined, 'manual')).toBe('grok')
  })

  // The claude side of the same rule, pinned here too so the two conventions are readable together
  // (the canonical claude pin lives in workspace.test.ts).
  it('keeps claude flag-LAST, because its prompt is a plain positional', () => {
    expect(cmd('claude', 'fix the bug', 'auto')).toBe("claude 'fix the bug' --permission-mode auto")
  })

  it('composes the right approval flag per agent', () => {
    // gemini takes a positional prompt with no separator, so the flag goes last, as claude's does.
    expect(cmd('gemini', 'explain this repo', 'acceptEdits')).toBe(
      "gemini 'explain this repo' --approval-mode auto_edit"
    )
    // codex in a mode it cannot express: the bare command, never a substituted flag.
    expect(cmd('codex', 'explain this repo', 'plan')).toBe("codex 'explain this repo'")
    // ...and in one it can, the flag lands last, same convention.
    expect(cmd('codex', 'explain this repo', 'auto')).toBe(
      "codex 'explain this repo' --ask-for-approval on-request"
    )
  })

  /**
   * The composed line is the only place the separator rule and the mapping meet, and each agent's
   * flag SPELLING differs — so a mapping change that swapped two agents' flags would still satisfy
   * approval-mode.test.ts. Pinned per agent, on one mode all four express, at the composed layer.
   */
  it('never lets one agent emit another agent’s flag', () => {
    expect(cmd('claude', undefined, 'bypassPermissions')).toBe(
      'claude --permission-mode bypassPermissions'
    )
    expect(cmd('grok', undefined, 'bypassPermissions')).toBe(
      'grok --permission-mode bypassPermissions'
    )
    expect(cmd('gemini', undefined, 'bypassPermissions')).toBe('gemini --approval-mode yolo')
    expect(cmd('codex', undefined, 'bypassPermissions')).toBe('codex --ask-for-approval never')
  })
})
