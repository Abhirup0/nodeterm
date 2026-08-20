/**
 * The session-scoped project-grant ledger + targeting gate (issue #338 PR 1, spec P2/P3 + §3/§5).
 *
 * The properties pinned here are the security spine of project targeting:
 *  - a grant is PER-CALLER (P2): caller B presenting an id granted to caller A is refused;
 *  - a grant is SESSION-SCOPED (P3): cleared per-caller on teardown, never persisted — the module
 *    is pure in-memory state with no fs and no electron import (asserted structurally below);
 *  - the gate FAILS CLOSED: unverified, unknown target, SSH target, ungranted target all refuse
 *    with a named error;
 *  - cwd validation resolves ONCE and stats ONCE (P7, CodeQL single-fd posture).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  GRANT_CAP,
  grant,
  isGranted,
  atCap,
  clearCaller,
  clearAll,
  gateProjectTarget,
  validateOpenProjectCwd,
  PROJECT_TARGETABLE_VERBS,
  PROJECT_TARGETING_REFUSAL,
  PROJECT_TARGET_REFUSED,
  PROJECT_TARGET_SSH_UNSUPPORTED,
  OPEN_PROJECT_CWD_INVALID
} from './project-grants'

beforeEach(() => clearAll())

describe('the grant ledger is per-caller (P2)', () => {
  it('a grant authorizes the granted caller and nobody else', () => {
    expect(grant('caller-a', 'proj-1')).toBe('ok')
    expect(isGranted('caller-a', 'proj-1')).toBe(true)
    // THE pin: caller B using an id granted to caller A is refused. A globally-keyed ledger
    // passes every single-caller test and fails exactly this one.
    expect(isGranted('caller-b', 'proj-1')).toBe(false)
    expect(isGranted('caller-a', 'proj-2')).toBe(false)
  })

  it('granting the same id twice is idempotent and costs one cap slot', () => {
    expect(grant('caller-a', 'proj-1')).toBe('ok')
    expect(grant('caller-a', 'proj-1')).toBe('ok')
    for (let i = 1; i < GRANT_CAP; i++) expect(grant('caller-a', `proj-extra-${i}`)).toBe('ok')
    // proj-1 counted once, so exactly GRANT_CAP distinct ids fit.
    expect(atCap('caller-a')).toBe(true)
  })
})

describe('the grant ledger is session-scoped (P3)', () => {
  it('clearCaller revokes that caller and only that caller', () => {
    grant('caller-a', 'proj-1')
    grant('caller-b', 'proj-2')
    clearCaller('caller-a')
    expect(isGranted('caller-a', 'proj-1')).toBe(false)
    expect(isGranted('caller-b', 'proj-2')).toBe(true)
  })

  it('clearAll empties the ledger (the app-restart lifetime, exercised by beforeEach)', () => {
    grant('caller-a', 'proj-1')
    clearAll()
    expect(isGranted('caller-a', 'proj-1')).toBe(false)
  })

  it('the module is pure: no fs, no electron, no persistence path to write through', () => {
    // Structural, in the no-electron.test.ts style: the P3 claim "never persisted" is a property
    // of the SOURCE — an in-memory Map with no import that could reach a disk or the shell.
    const src = fs.readFileSync(path.join(__dirname, 'project-grants.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"]electron(\/[^'"]*)?['"]|require\(['"]electron/)
    expect(src).not.toMatch(/from ['"](node:)?fs['"]|require\(['"](node:)?fs['"]\)/)
    expect(src).not.toMatch(/from ['"](node:)?child_process['"]/)
  })
})

describe('the per-caller cap (open-project-grant-cap)', () => {
  it('admits exactly GRANT_CAP grants and refuses the 65th', () => {
    for (let i = 0; i < GRANT_CAP; i++) {
      expect(grant('caller-a', `proj-${i}`)).toBe('ok')
      expect(atCap('caller-a')).toBe(i === GRANT_CAP - 1)
    }
    expect(grant('caller-a', 'proj-one-too-many')).toBe('cap')
    // Refused means refused: the over-cap id was NOT recorded (no silent eviction either — the
    // first 64 all survive).
    expect(isGranted('caller-a', 'proj-one-too-many')).toBe(false)
    expect(isGranted('caller-a', 'proj-0')).toBe(true)
    expect(isGranted('caller-a', `proj-${GRANT_CAP - 1}`)).toBe(true)
    // The cap is per caller, not global.
    expect(atCap('caller-b')).toBe(false)
    expect(grant('caller-b', 'proj-0')).toBe('ok')
  })
})

describe('gateProjectTarget (spec §3/§5) — every branch, fail closed', () => {
  const base = {
    verified: true,
    verb: 'open-claude',
    targetProjectId: 'proj-t' as string | undefined,
    callerProjectId: 'proj-own' as string | undefined,
    targetIsSsh: false as boolean | undefined,
    granted: false
  }

  it('is a no-op for a verb that is not a project-targetable open', () => {
    expect(PROJECT_TARGETABLE_VERBS.has('open-claude')).toBe(true)
    expect(PROJECT_TARGETABLE_VERBS.has('open-terminal')).toBe(true)
    expect(PROJECT_TARGETABLE_VERBS.has('open-agent')).toBe(true)
    expect(PROJECT_TARGETABLE_VERBS.has('show-image')).toBe(false)
    expect(gateProjectTarget({ ...base, verb: 'list' })).toBe('allow')
  })

  it('is a no-op when no --project is present', () => {
    expect(gateProjectTarget({ ...base, targetProjectId: undefined })).toBe('allow')
  })

  it('refuses an unverified caller with the flat sentence, before anything else', () => {
    // Even the caller's OWN project: --project requires verified === true (P1's arg half), and
    // the sentence carries no token/restart advice (a designed refusal, not an outage).
    const r = gateProjectTarget({ ...base, verified: false, targetProjectId: 'proj-own' })
    expect(r).toEqual({ refuse: PROJECT_TARGETING_REFUSAL })
    for (const hint of ['token', 'restart', 'identity']) {
      expect(PROJECT_TARGETING_REFUSAL.toLowerCase()).not.toContain(hint)
    }
  })

  it('refuses an unknown/deleted target id — fail closed, same sentence as ungranted', () => {
    // targetIsSsh === undefined is "main's own store does not know this project". The refusal
    // reuses PROJECT_TARGET_REFUSED so a probing caller cannot distinguish "does not exist"
    // from "exists but not granted" (no project-existence oracle).
    const r = gateProjectTarget({ ...base, targetIsSsh: undefined, granted: true })
    expect(r).toEqual({ refuse: PROJECT_TARGET_REFUSED })
  })

  it('allows the caller its own project, SSH-own included (the legacy live path)', () => {
    expect(gateProjectTarget({ ...base, targetProjectId: 'proj-own' })).toBe('allow')
    expect(
      gateProjectTarget({ ...base, targetProjectId: 'proj-own', targetIsSsh: true })
    ).toBe('allow')
  })

  it('refuses an SSH target that is not the caller own project — even a (impossible) granted one', () => {
    // Grants are only ever minted by local open-project, so a granted SSH id cannot exist; the
    // SSH check running BEFORE the granted check is the belt for that invariant.
    const r = gateProjectTarget({ ...base, targetIsSsh: true, granted: true })
    expect(r).toEqual({ refuse: PROJECT_TARGET_SSH_UNSUPPORTED })
  })

  it('allows a granted target and refuses an ungranted one with the named sentence', () => {
    expect(gateProjectTarget({ ...base, granted: true })).toBe('allow')
    expect(gateProjectTarget({ ...base, granted: false })).toEqual({
      refuse: PROJECT_TARGET_REFUSED
    })
    expect(PROJECT_TARGET_REFUSED).toBe(
      'project-target-refused: you may only target your own project or a project id ' +
        'open-project returned to you in this session'
    )
  })

  it('composes with the real ledger: granted for A, still refused for B (P2 end-to-end)', () => {
    grant('caller-a', 'proj-t')
    const forCaller = (caller: string) =>
      gateProjectTarget({ ...base, granted: isGranted(caller, 'proj-t') })
    expect(forCaller('caller-a')).toBe('allow')
    expect(forCaller('caller-b')).toEqual({ refuse: PROJECT_TARGET_REFUSED })
  })
})

describe('validateOpenProjectCwd (P7) — resolved once, statted once, fails closed', () => {
  const dirStat = { isDirectory: () => true }
  const fileStat = { isDirectory: () => false }

  it('refuses a relative path before touching the filesystem at all', () => {
    let stats = 0
    const r = validateOpenProjectCwd('repo/sub', () => ((stats++, dirStat)))
    expect(r).toEqual({ error: OPEN_PROJECT_CWD_INVALID })
    expect(stats).toBe(0)
    expect(validateOpenProjectCwd('', () => dirStat)).toEqual({ error: OPEN_PROJECT_CWD_INVALID })
    expect(validateOpenProjectCwd('./x', () => dirStat)).toEqual({
      error: OPEN_PROJECT_CWD_INVALID
    })
  })

  it('resolves traversal and stats the RESOLVED path, exactly once', () => {
    const statted: string[] = []
    const r = validateOpenProjectCwd('/tmp/a/../b/./c/', (p) => {
      statted.push(p)
      return dirStat
    })
    // The resolved form — never the raw argument — is what every later step (dedupe, the PR 2
    // dialog, storage) sees.
    expect(r).toEqual({ resolved: path.resolve('/tmp/a/../b/./c/') })
    expect(statted).toEqual([path.resolve('/tmp/a/../b/./c/')])
  })

  it('refuses a nonexistent path (stat throws) and a non-directory, with the named error', () => {
    expect(
      validateOpenProjectCwd('/no/such/dir', () => {
        throw new Error('ENOENT')
      })
    ).toEqual({ error: OPEN_PROJECT_CWD_INVALID })
    expect(validateOpenProjectCwd('/tmp/some.file', () => fileStat)).toEqual({
      error: OPEN_PROJECT_CWD_INVALID
    })
  })
})

describe('main wiring (structural) — the wrapper records, consumes and clears correctly', () => {
  // Structural in the control-destructive.test.ts sense and for the same reason: the wiring lives
  // inside index.ts's setControlHandler wrapper and whenReady closure, which have no unit seam,
  // and the property pinned — WHEN a grant is recorded and WHEN it dies — is a property of the
  // source. The behavioural halves (the ledger, the gate, the cwd rules) are proven above against
  // the real functions.
  const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')

  it('records a grant ONLY under verified && result.ok with a string projectId (the open-browser pattern)', () => {
    const at = src.indexOf("verb === 'open-project' && verified && result.ok")
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 400)
    expect(block).toContain("typeof opened?.projectId === 'string'")
    expect(block).toContain('grantProjectTo(nodeId, opened.projectId)')
    // No other call site mints a grant: the record path is the wrapper's, once.
    expect(src.match(/grantProjectTo\(/g)?.length).toBe(1)
  })

  it('consumes the ledger per-CALLER and gates before forwarding to the renderer', () => {
    // The gate reads isGranted(nodeId, …) — the verified caller of THIS request — never a global
    // or target-derived key, and it runs inside the wrapper before webContents.send.
    expect(src).toMatch(/granted: projectGrantedTo\(nodeId, args\.project\)/)
    const gateAt = src.indexOf('gateProjectTarget({')
    const forwardAt = src.indexOf('target.webContents.send(IPC.agentControl', gateAt)
    expect(gateAt).toBeGreaterThan(-1)
    expect(forwardAt).toBeGreaterThan(gateAt)
    // The target's SSH/existence meta comes from main's own store, never the request.
    expect(src).toMatch(/workspaceStore\.projectMetaFor\(args\.project\)/)
  })

  it('clears a caller on BOTH pty teardown paths (destroy + recycle) — spec P3', () => {
    expect(src).toMatch(
      /corePlatform\.on\(IPC\.ptyDestroy, \(nodeId: string\) => clearProjectGrants\(nodeId\)\)/
    )
    expect(src).toMatch(
      /corePlatform\.on\(IPC\.ptyRecycle, \(nodeId: string\) => clearProjectGrants\(nodeId\)\)/
    )
  })

  it('open-project resolves + replaces the cwd in MAIN before forwarding (P7)', () => {
    const at = src.indexOf('validateOpenProjectCwd(args.cwd')
    expect(at).toBeGreaterThan(-1)
    // The resolved form replaces the raw argument in the forwarded args.
    expect(src.slice(at, at + 400)).toContain('args = { ...args, cwd: cwd.resolved }')
  })
})
