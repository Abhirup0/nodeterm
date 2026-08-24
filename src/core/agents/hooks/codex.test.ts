import { describe, expect, it } from 'vitest'
import { buildCodexHooksAndTrust, buildManagedCommand, CODEX_EVENTS } from './codex'
import { computeTrustedHash } from './codex-trust'

// The command form a codex hook carries: `if [ -x '<script>' ]; then /bin/sh '<script>'; fi`.
// The trust hash is computed over THIS exact byte string, so the hooks.json command and the
// config.toml trust entry must always come from the same builder.
describe('buildManagedCommand', () => {
  it('wraps the script path in the [ -x ] guard with POSIX single-quoting', () => {
    expect(buildManagedCommand('/a/b/codex.sh')).toBe(
      "if [ -x '/a/b/codex.sh' ]; then /bin/sh '/a/b/codex.sh'; fi"
    )
  })
})

describe('buildCodexHooksAndTrust', () => {
  it('returns null for an unparseable (null) hooks.json so the caller never clobbers it', () => {
    expect(buildCodexHooksAndTrust(null, 'cmd', '/h/hooks.json')).toBeNull()
  })

  it('appends the managed handler to all eight events + emits one trust entry per event', () => {
    const command = buildManagedCommand('/home/u/.nodeterm/agent-hooks/codex.sh')
    const built = buildCodexHooksAndTrust({}, command, '/home/u/.codex/hooks.json')
    expect(built).not.toBeNull()
    const { config, trustEntries } = built!
    // one definition per subscribed event, our managed handler last
    for (const ev of CODEX_EVENTS) {
      const defs = config.hooks?.[ev]
      expect(defs?.at(-1)?.hooks?.[0]?.command).toBe(command)
    }
    expect(trustEntries).toHaveLength(CODEX_EVENTS.length)
    expect(trustEntries.every((e) => e.command === command)).toBe(true)
    expect(trustEntries.every((e) => e.sourcePath === '/home/u/.codex/hooks.json')).toBe(true)
  })

  it('is idempotent — re-running on its own output does not duplicate the managed handler', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    const first = buildCodexHooksAndTrust({}, command, '/x/hooks.json')!
    const second = buildCodexHooksAndTrust(first.config, command, '/x/hooks.json')!
    for (const ev of CODEX_EVENTS) {
      // exactly one managed handler, still at the tail
      const defs = second.config.hooks?.[ev] ?? []
      const managed = defs.filter((d) => d.hooks?.some((h) => h.command === command))
      expect(managed).toHaveLength(1)
      expect(defs.at(-1)?.hooks?.[0]?.command).toBe(command)
    }
  })

  it('preserves a user-authored hook at its original index before the managed handler', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    const userDef = { hooks: [{ type: 'command' as const, command: 'echo mine' }] }
    const built = buildCodexHooksAndTrust({ hooks: { Stop: [userDef] } }, command, '/x/hooks.json')!
    const stop = built.config.hooks?.Stop ?? []
    expect(stop[0]).toEqual(userDef)
    expect(stop.at(-1)?.hooks?.[0]?.command).toBe(command)
  })

  it('keeps two user definitions at their trust-key indices and trusts the managed tail', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    const firstUserDef = { hooks: [{ type: 'command' as const, command: 'echo first' }] }
    const secondUserDef = { hooks: [{ type: 'command' as const, command: 'echo second' }] }
    const built = buildCodexHooksAndTrust(
      { hooks: { SessionStart: [firstUserDef, secondUserDef] } },
      command,
      '/x/hooks.json'
    )!
    const sessionStart = built.config.hooks?.SessionStart ?? []
    expect(sessionStart[0]).toEqual(firstUserDef)
    expect(sessionStart[1]).toEqual(secondUserDef)
    expect(sessionStart[2]?.hooks?.[0]?.command).toBe(command)
    expect(built.trustEntries.find((entry) => entry.eventLabel === 'session_start')).toMatchObject({
      groupIndex: 2,
      handlerIndex: 0
    })
  })

  it('sweeps a stale managed handler out of an event we no longer subscribe to', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    // PreCompact is not in CODEX_EVENTS; a stale managed copy there must be removed.
    const stale = { hooks: [{ type: 'command' as const, command }] }
    const built = buildCodexHooksAndTrust({ hooks: { PreCompact: [stale] } }, command, '/x/hooks.json')!
    expect(built.config.hooks?.PreCompact).toBeUndefined()
  })

  // GOLDEN: the first six hashes were read from a LIVE codex config.toml on a host where the status
  // hooks fire correctly (codex-cli 0.114.0). Locking them guards the exact JSON canonicalization
  // codex hashes against — any drift here silently breaks every codex status badge.
  it('matches the byte-exact trust hashes codex accepts in the field', () => {
    const command = buildManagedCommand('/root/.nodeterm-server/agent-hooks/codex.sh')
    const built = buildCodexHooksAndTrust({}, command, '/root/.codex/hooks.json')!
    const byLabel = Object.fromEntries(built.trustEntries.map((e) => [e.eventLabel, computeTrustedHash(e)]))
    expect(byLabel).toMatchObject({
      session_start: 'sha256:9ad2be7ba503a6c29d73fe63da7e6e6b90a3418a9367d27e8b79ad67ce4208e6',
      user_prompt_submit: 'sha256:ce3fcb34da617dc3be97142660e0c2ae30c9000333b0bfa29ffde7a941813840',
      pre_tool_use: 'sha256:4518d886ca33ee61eba15a15e6348df03891a37f496a9a29a7eaae8b05623eed',
      permission_request: 'sha256:c15e31e91f0ad513f1dd37bbbf5e1263cb0ba7a819b16dd60bc85f576d5bcb85',
      post_tool_use: 'sha256:ec6d59bff150ef00c30f7ef63abdf3c5a839a12f98ebe5dc542ecdfcc2da9d2f',
      stop: 'sha256:bd559fa7db307ab42dac8fa42b49c46b3daa50f944adad2f0a97140a70c70081',
      // The subagent pair was verified live differently: a capture home whose trust entries were
      // computed by this same algorithm had codex-cli 0.146.0 FIRE SubagentStart/SubagentStop
      // (spawn_agent measurement run, 2026-08-24) — i.e. codex accepted hashes of this shape for
      // these labels. The values below pin the canonicalization for this command string.
      subagent_start: 'sha256:9034d6329983b581fc9f996344766d6129321c5c33369a79c9971aa8879d3d5f',
      subagent_stop: 'sha256:88c207ae65d9d016967fce19b01735b5700f827cbfdb48692e42305f7427f0b6'
    })
  })

  it('subscribes the subagent pair (spawn_agent fan-out) with snake_case labels', () => {
    expect(CODEX_EVENTS).toContain('SubagentStart')
    expect(CODEX_EVENTS).toContain('SubagentStop')
  })
})
