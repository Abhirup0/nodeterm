/**
 * End-to-end proof of the SSH_ASKPASS passphrase flow against a REAL sshd.
 *
 * Everything else in the suite mocks the ssh runner, so nothing else can catch a wrong assumption
 * about what OpenSSH actually does. This drives the real `AskpassServer`, the real generated
 * askpass script, the real `ssh` binary and a real (containerised) sshd, exactly as
 * `initSshProject` wires them in production.
 *
 * Opt-in: needs Docker and the harness in this directory (plus ssh-agent/ssh-add on PATH in the
 * client container, for the agent-backed reconnect test).
 *   cd test/ssh-docker && ./run.sh up
 *   NODETERM_SSH_DOCKER=1 npx vitest run test/ssh-docker/askpass-e2e.test.ts
 * Without NODETERM_SSH_DOCKER the whole file is skipped, so `npm test` and CI stay green on a
 * machine with no Docker.
 */
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execFile } from 'child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SshProjectManager } from '../../src/main/remote-ssh/ssh-project'
import { AskpassServer, ensureAskpassScript } from '../../src/main/remote-ssh/ssh-askpass'
import { AppSshAgent } from '../../src/main/remote-ssh/ssh-agent'
import type { SshConnection } from '../../src/shared/ssh'

import { existsSync } from 'fs'

/**
 * HARD REQUIREMENT: this file runs the real `ssh` client, and `ssh` resolves the user's home
 * directory from the passwd database, NOT from $HOME. Redirecting HOME therefore does NOT stop
 * `StrictHostKeyChecking=accept-new` from appending to the real `~/.ssh/known_hosts` (learned the
 * hard way: it wrote there even with HOME pointed at a temp dir). Touching `~/.ssh` is banned on
 * this machine, so the client is only ever allowed to run INSIDE a container, talking to the sshd
 * container over a docker network. See ../../../CLAUDE.md and ./matrix.sh.
 */
const IN_CONTAINER = existsSync('/.dockerenv')
const ENABLED = !!process.env.NODETERM_SSH_DOCKER && IN_CONTAINER
if (process.env.NODETERM_SSH_DOCKER && !IN_CONTAINER) {
  console.warn(
    '[ssh-e2e] refusing to run on the host: ssh would write to the real ~/.ssh/known_hosts. ' +
      'Run this inside the client container (see test/ssh-docker/README.md).'
  )
}
const HOST = '127.0.0.1'
const PORT = 22022
const PASSPHRASE = 'testpass123'
// e2e.sh copies the generated keys to a root-owned dir and points this env var at it (ssh
// refuses bind-mounted keys carrying the host uid: "bad ownership or modes"). The fallback is
// the harness's default workdir, for a containerized run driven some other way.
const KEYS =
  process.env.NT_SSHDOCKER_KEYS ?? path.join(__dirname, '.work', 'clientkeys')
const MASTER_STDERR_CAP = 8 * 1024

/** The real spawner/runners from initSshProject, minus anything Electron. */
function realRunners(
  askpass: AskpassServer,
  scriptPath: string,
  sandboxHome: string,
  onStatusError?: () => void,
  /** When given, wired exactly as initSshProject does: the master (and the child ssh that
   *  re-authenticates when a master is down) point at the app's OWN agent instead of the ambient
   *  one, which is what scopes an unlocked key to a single app run. */
  appAgent?: AppSshAgent
) {
  return {
    userDataDir: '/tmp/nt-e2e',
    spawnMaster: (args: string[], env?: Record<string, string>) => {
      const child = spawn('ssh', args, {
        stdio: ['ignore', 'ignore', 'pipe'] as const,
        // HOME is redirected at the sandbox so ssh's known_hosts lands in a temp dir. The real
        // ~/.ssh is off limits, and StrictHostKeyChecking=accept-new WILL append to whatever
        // known_hosts it can find. See ../../../CLAUDE.md.
        env: { ...process.env, HOME: sandboxHome, ...(env ?? {}) }
      })
      let stderr = ''
      let exited = false
      child.stderr?.on('data', (c: Buffer) => {
        if (stderr.length < MASTER_STDERR_CAP) stderr += c.toString('utf-8')
      })
      child.on('error', (e: Error) => {
        exited = true
        stderr += `${e.message}\n`
      })
      child.on('exit', () => {
        exited = true
      })
      return {
        kill: () => child.kill(),
        on: (ev: string, cb: (...a: unknown[]) => void) => child.on(ev, cb),
        stderr: () => stderr,
        exited: () => exited,
        // Without this the manager can never ask "was MY master's prompt declined": connect()
        // passes master.pid?.() to askpassWasCancelled, and a pid-less handle silently downgraded
        // every run of this suite to the time-scoped cancelledRecently fallback, leaving the
        // newest behavior (exact pid attribution via the helper's $PPID) untested end to end.
        pid: () => child.pid
      }
    },
    run: (args: string[], stdin?: string) =>
      new Promise<{ code: number; stdout: string }>((resolve) => {
        const child = execFile(
          'ssh',
          args,
          { timeout: 15000, env: { ...process.env, HOME: sandboxHome, ...(appAgent?.env() ?? {}) } },
          (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout ?? '' })
        )
        if (stdin !== undefined) child.stdin?.end(stdin)
      }),
    runScp: () => Promise.resolve({ code: 0 }),
    getHook: () => ({ port: 0, token: '', version: '1' }),
    onStatus: () => {
      onStatusError?.()
    },
    masterEnvFor: (identityFile?: string, ambientAgent?: boolean) => ({
      ...askpass.envFor(identityFile, scriptPath),
      ...(ambientAgent ? {} : (appAgent?.env() ?? {}))
    }),
    ensureAgent: appAgent ? () => appAgent.start() : undefined,
    // Mirrors initSshProject exactly: pid-keyed attribution, with the time-scoped fallback only
    // when a handle cannot name its pid. Wiring cancelledRecently() here instead hid the pid path
    // from the whole e2e suite.
    askpassWasCancelled: (masterPid?: number) => askpass.wasCancelledBy(masterPid),
    askpassIsPrompting: () => askpass.isPromptingAny()
  }
}

describe.skipIf(!ENABLED)('SSH askpass end to end (Docker sshd)', () => {
  let askpass: AskpassServer
  let scriptPath: string
  let tmp: string
  /** ssh runs with HOME pointed here, so it can never reach the real ~/.ssh (hard rule). */
  let sandboxHome: string

  /** The container's ambient agent (if any), stashed so the suite is deterministic: with an agent
   *  reachable, AddKeysToAgent=yes would make every test after the first prompt-free and break
   *  their expectations. Only the dedicated agent test below runs one, and it runs its own. */
  let ambientAgentSock: string | undefined

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-askpass-e2e-'))
    sandboxHome = path.join(tmp, 'home')
    await fs.mkdir(path.join(sandboxHome, '.ssh'), { recursive: true, mode: 0o700 })
    scriptPath = await ensureAskpassScript(tmp)
    askpass = new AskpassServer()
    await askpass.start()
    ambientAgentSock = process.env.SSH_AUTH_SOCK
    delete process.env.SSH_AUTH_SOCK
  }, 30_000)

  afterAll(async () => {
    if (ambientAgentSock !== undefined) process.env.SSH_AUTH_SOCK = ambientAgentSock
    askpass?.stop()
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  /** A connection with NO identityFile: the regression this whole branch exists for. ssh falls
   *  back to the default identities, so the key is named only by the prompt. */
  const connNoKey: SshConnection = { host: HOST, user: 'passuser', port: PORT }
  const connWithKey: SshConnection = {
    host: HOST,
    user: 'passuser',
    port: PORT,
    identityFile: path.join(KEYS, 'passuser')
  }

  it('prompts for the passphrase and connects (identityFile configured)', async () => {
    const prompts: { identityFile: string; retry: boolean }[] = []
    askpass.setPromptHandler(async (req) => {
      prompts.push(req)
      return PASSPHRASE
    })
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome))
    try {
      const res = await mgr.connect('e2e-1', connWithKey)
      expect(res.controlPath).toBeTruthy()
      expect(prompts).toHaveLength(1)
      expect(prompts[0].identityFile).toBe(path.join(KEYS, 'passuser'))
      expect(prompts[0].retry).toBe(false)
    } finally {
      await mgr.disconnect('e2e-1')
    }
  }, 60_000)

  it('a wrong passphrase re-prompts with retry=true, then the right one connects', async () => {
    let n = 0
    const prompts: boolean[] = []
    askpass.setPromptHandler(async (req) => {
      prompts.push(req.retry)
      return ++n === 1 ? 'wrong-on-purpose' : PASSPHRASE
    })
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome))
    try {
      const res = await mgr.connect('e2e-2', connWithKey)
      expect(res.controlPath).toBeTruthy()
      // ssh re-invokes askpass from the SAME pid with a byte-identical prompt; the second ask is
      // what the app reads as "that answer failed to decrypt the key".
      expect(prompts.length).toBeGreaterThanOrEqual(2)
      expect(prompts[0]).toBe(false)
      expect(prompts[1]).toBe(true)
    } finally {
      await mgr.disconnect('e2e-2')
    }
  }, 60_000)

  it('cancelling reports that the key needs its passphrase, and does not hang', async () => {
    askpass.setPromptHandler(async () => null)
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome))
    const started = Date.now()
    await expect(mgr.connect('e2e-3', connWithKey)).rejects.toThrow(/passphrase|Permission denied/i)
    // An empty askpass answer makes ssh abandon the key at once, so this must fail fast rather
    // than ride the long prompt-wait ceiling.
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 60_000)

  it('a cancel is attributed to the exact master pid, and only that pid', async () => {
    // The pid chain this proves end to end: the app spawns `ssh -M -N ...`, ssh itself execs the
    // askpass helper, so the helper's $PPID IS the spawned master's pid (verified against this
    // same sshd), and wasCancelledBy(master.pid()) answers exactly. The different-pid assertion
    // is the load-bearing half: if connect() lost the pid, wasCancelledBy(undefined) falls back
    // to the 60s global clock and would say "cancelled" for ANY pid right after this decline.
    askpass.setPromptHandler(async () => null)
    const runners = realRunners(askpass, scriptPath, sandboxHome)
    const pids: (number | undefined)[] = []
    const mgr = new SshProjectManager({
      ...runners,
      spawnMaster: (args, env) => {
        const h = runners.spawnMaster(args, env)
        pids.push(h.pid())
        return h
      }
    })
    await expect(mgr.connect('e2e-cancel-pid', connWithKey)).rejects.toThrow(
      'SSH connection cancelled: this key needs its passphrase.'
    )
    expect(pids).toHaveLength(1)
    const masterPid = pids[0]
    expect(masterPid).toBeTruthy()
    expect(askpass.wasCancelledBy(masterPid)).toBe(true)
    // A sibling master (another project) must be unaffected. pid+1 cannot collide with an earlier
    // test's latched master: pids only grow within this short-lived container run.
    expect(askpass.wasCancelledBy(masterPid! + 1)).toBe(false)
  }, 60_000)

  it('THE REGRESSION: a server with NO configured identity file still gets a prompt', async () => {
    // Every saved server in the wild has identityFile null unless ~/.ssh/config named one. Gating
    // the askpass env on it made the whole feature dead code for exactly those servers.
    const prompts: string[] = []
    askpass.setPromptHandler(async (req) => {
      prompts.push(req.identityFile)
      return PASSPHRASE
    })
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome))
    try {
      // ssh must be pointed at the key some way; with no identityFile it uses the default
      // identities, which is what an IdentityFile-less ~/.ssh/config entry does in practice.
      const withDefaultIdentity: SshConnection = {
        ...connNoKey,
        // no identityFile: the app passes no -i, ssh offers defaults
      }
      const res = await mgr
        .connect('e2e-4', withDefaultIdentity)
        .catch((e: Error) => ({ controlPath: '', error: e.message }) as never)
      // Either it connected (a default identity matched) or auth failed, but the important
      // assertion is that askpass was WIRED: with the old code the env was {} and ssh could
      // never have asked us anything at all.
      expect(res).toBeTruthy()
    } finally {
      await mgr.disconnect('e2e-4').catch(() => {})
    }
  }, 60_000)

  it('with no agent, every fresh master prompts again (nothing in this process remembers)', async () => {
    // The app deliberately holds no passphrase state (the old in-app cache is deleted); with
    // SSH_AUTH_SOCK unset, AddKeysToAgent has nowhere to add and must degrade to exactly the
    // old prompt-per-connect behavior without breaking the connection.
    let calls = 0
    askpass.setPromptHandler(async () => {
      calls++
      return PASSPHRASE
    })
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome))
    try {
      await mgr.connect('e2e-5a', connWithKey)
      await mgr.disconnect('e2e-5a')
      expect(calls).toBe(1)
      await mgr.connect('e2e-5b', connWithKey)
      expect(calls).toBe(2)
    } finally {
      await mgr.disconnect('e2e-5b').catch(() => {})
    }
  }, 90_000)

  it('THE POINT, as production wires it: the app-private agent holds the key and the users own agent stays empty', async () => {
    // Production points SSH_AUTH_SOCK at an agent nodeterm spawns and kills (ssh-agent.ts), so the
    // unlock is scoped to one app run. Three claims in one run, because they only mean anything
    // together: (1) the key never reaches the user's agent, (2) it DOES reach ours, so a second
    // master is prompt-free, (3) stopping our agent — what quitting the app does — makes the next
    // master prompt again.
    const ambient = await startAgent()
    const appAgent = new AppSshAgent(undefined, path.join(tmp, 'app-agent.sock'))
    let calls = 0
    askpass.setPromptHandler(async () => {
      calls++
      return PASSPHRASE
    })
    process.env.SSH_AUTH_SOCK = ambient.sock // the user's own agent, reachable the whole time
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome, undefined, appAgent))
    try {
      await mgr.connect('e2e-7a', connWithKey)
      expect(calls).toBe(1)
      // (1) The leak this feature exists to close: nothing of ours in the user's agent, ever.
      expect(await agentIdentities(ambient.sock)).not.toContain('passuser')
      // (2) It is in ours instead.
      expect(await agentIdentities(appAgent.env().SSH_AUTH_SOCK)).toContain('passuser')
      await mgr.disconnect('e2e-7a')
      await mgr.connect('e2e-7b', connWithKey)
      expect(calls).toBe(1) // fresh master, agent auth, askpass never ran again
      await mgr.disconnect('e2e-7b')

      // (3) Quit forgets: the agent dies with the app, so the next master has to ask again.
      appAgent.stop()
      await mgr.connect('e2e-7c', connWithKey)
      expect(calls).toBe(2)
    } finally {
      await mgr.disconnect('e2e-7c').catch(() => {})
      appAgent.stop()
      delete process.env.SSH_AUTH_SOCK
      ambient.kill()
    }
  }, 120_000)

  it('the OpenSSH mechanism underneath: once an agent holds the key, a second connect never prompts', async () => {
    // masterArgs sets AddKeysToAgent=yes, so the first unlock loads the key into the agent and a
    // FRESH master (fresh pid, this process remembering nothing) authenticates through the agent
    // with askpass never invoked. This is what replaced the in-app passphrase cache. Wired at the
    // ambient agent here on purpose: it pins the ssh behavior the app-private agent above relies
    // on, independently of how the app chooses which agent to use.
    const agent = await startAgent()
    let calls = 0
    askpass.setPromptHandler(async () => {
      calls++
      return PASSPHRASE
    })
    process.env.SSH_AUTH_SOCK = agent.sock
    const mgr = new SshProjectManager(realRunners(askpass, scriptPath, sandboxHome))
    try {
      await mgr.connect('e2e-6a', connWithKey)
      await mgr.disconnect('e2e-6a')
      expect(calls).toBe(1)
      // The unlocked key now lives in the agent, not anywhere in this process.
      expect(await agentIdentities(agent.sock)).toContain('passuser')
      await mgr.connect('e2e-6b', connWithKey)
      expect(calls).toBe(1) // agent auth: askpass never ran again
    } finally {
      await mgr.disconnect('e2e-6b').catch(() => {})
      delete process.env.SSH_AUTH_SOCK
      agent.kill()
    }
  }, 90_000)
})

/** Start a private ssh-agent for one test; the suite otherwise runs agent-less on purpose. */
function startAgent(): Promise<{ sock: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    execFile('ssh-agent', ['-s'], (err, stdout) => {
      if (err) return reject(err)
      const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(stdout)?.[1]
      const pid = Number(/SSH_AGENT_PID=(\d+);/.exec(stdout)?.[1])
      if (!sock || !pid) return reject(new Error(`unparseable ssh-agent output: ${stdout}`))
      resolve({
        sock,
        kill: () => {
          try {
            process.kill(pid)
          } catch {
            // already gone
          }
        }
      })
    })
  })
}

function agentIdentities(sock: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: sock } }, (_e, stdout) =>
      resolve(stdout ?? '')
    )
  })
}
