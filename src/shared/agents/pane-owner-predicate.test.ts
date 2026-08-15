import { describe, it, expect } from 'vitest'
import { isAgentPane, AGENT_BINARIES } from './pane-owner-predicate'
import { isShellCommand } from './pane'
import { BUILTIN_AGENT_IDS, AGENT_CONFIG } from './config'

const owner = (argv: string[], command = 'node') => ({
  panePid: 1,
  tty: '/dev/pts/1',
  command,
  argv
})

describe('isAgentPane', () => {
  it('recognises the expected agent binary in the foreground group', () => {
    expect(isAgentPane(owner(['node /usr/local/bin/claude --resume x']), 'claude')).toBe('agent')
    expect(isAgentPane(owner(['/opt/homebrew/bin/codex']), 'codex')).toBe('agent')
    expect(isAgentPane(owner(['gemini']), 'gemini')).toBe('agent')
  })

  it('recognises it anywhere in the group, not only as the leader', () => {
    // A wrapper leads the group; the CLI is a child of it. Both are in the foreground group and
    // both will receive what we write, so either one proving the agent is present is enough.
    expect(
      isAgentPane(owner(['/bin/sh -c claude --resume x', 'node /usr/local/bin/claude --resume x']), 'claude')
    ).toBe('agent')
  })

  it('refuses a DIFFERENT agent — a claude message must not land in a codex pane', () => {
    expect(isAgentPane(owner(['node /usr/local/bin/codex']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['node /usr/local/bin/claude']), 'codex')).toBe('not-agent')
  })

  // The two holes the old negative predicate had, closed:
  it('refuses a shell OUTSIDE the seven-name allowlist', () => {
    for (const sh of ['nu', 'pwsh', 'xonsh', 'elvish', 'ssh host', 'python3 -i']) {
      const cmd = sh.split(' ')[0]
      // The old gate's exact reading: not one of seven shell names, therefore "an agent".
      expect(isShellCommand(cmd)).toBe(false)
      expect(isAgentPane(owner([sh], cmd), 'claude')).toBe('not-agent')
    }
  })

  it('refuses a pane whose CLI exited even though agentId is still persisted', () => {
    expect(isAgentPane(owner(['-zsh'], 'zsh'), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['/bin/bash'], 'bash'), 'claude')).toBe('not-agent')
  })

  it('answers unknown — never `agent` — when the read failed', () => {
    expect(isAgentPane(null, 'claude')).toBe('unknown')
    expect(isAgentPane(undefined, 'claude')).toBe('unknown')
    expect(isAgentPane(owner([]), 'claude')).toBe('unknown')
  })

  it('is not fooled by an argument that merely mentions the agent', () => {
    expect(isAgentPane(owner(['vim /etc/claude.conf']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['grep -r claude .']), 'claude')).toBe('not-agent')
    expect(isAgentPane(owner(['tail -f /var/log/claude.log']), 'claude')).toBe('not-agent')
    // The nastiest shape: a shell whose -c string names the agent. `-c` is an option, not a script
    // path, so interpreter resolution must not reach past it.
    expect(isAgentPane(owner(["sh -c 'grep claude .'"]), 'claude')).toBe('not-agent')
  })

  it('resolves an interpreter only when what follows is a script, never an option', () => {
    expect(isAgentPane(owner(['node /home/u/.local/share/npm/bin/claude']), 'claude')).toBe('agent')
    expect(isAgentPane(owner(['bun /opt/bin/codex mcp']), 'codex')).toBe('agent')
    expect(isAgentPane(owner(['node --inspect claude']), 'claude')).toBe('not-agent')
    // An OPTION that reads like the agent once the login-shell dash is stripped. This is the case
    // the "next token must not start with -" rule exists for: without it, `-claude` basenames to
    // `claude` and an interpreter flag is mistaken for the script it is not.
    expect(isAgentPane(owner(['node -claude']), 'claude')).toBe('not-agent')
  })

  it('answers unknown for a custom agent whose binary nothing can name', () => {
    // `custom:<uuid>` has no entry, and guessing one would be the exact class of mistake this
    // module replaces. The caller refuses, retryably, rather than admitting the pane.
    expect(isAgentPane(owner(['node /opt/bin/whatever']), 'custom:abc')).toBe('unknown')
  })

  it('accepts a caller-supplied binary list for a custom agent', () => {
    expect(isAgentPane(owner(['node /opt/bin/whatever']), 'custom:abc', ['whatever'])).toBe('agent')
    expect(isAgentPane(owner(['node /opt/bin/other']), 'custom:abc', ['whatever'])).toBe('not-agent')
  })

  it('covers every built-in agent, so a new one cannot be silently unverifiable', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      expect(AGENT_BINARIES[id], `${id} has no binary list`).toBeTruthy()
      // The list must still name the process the launcher actually starts.
      expect(AGENT_BINARIES[id]).toContain(AGENT_CONFIG[id].expectedProcess)
      expect(isAgentPane(owner([`/usr/local/bin/${AGENT_CONFIG[id].expectedProcess}`]), id)).toBe('agent')
    }
  })
})
