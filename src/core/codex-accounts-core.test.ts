import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_ID_RE,
  assertCodexAccountId,
  isSafeAccountId,
  codexAccountHome,
  codexHomeForAccount,
  codexSessionEnv,
  codexSocketForAccount,
  codexTmuxEnvArgs,
  codexUsageAccounts,
  legacyCodexAccountHome,
  migrateLegacyCodexAccountHome,
  migrateLegacyCodexAccountHomes,
  needsCodexAccountScope,
  remoteCodexHome,
  remoteCodexSocket,
  remoteCodexTmuxEnvArgs,
  systemCodexHome,
  AUTH_ENV_STRIP,
  stripCodexAuthEnv
} from './codex-accounts-core'

describe('Codex account id validation (supply-chain guard)', () => {
  it.each(['a', 'A0', 'account-a', 'be28d3d4-c18c-430c-a257-ae550d3dd7ed', 'a.b_c-1'])(
    'accepts safe id %s',
    (id) => {
      expect(isSafeAccountId(id)).toBe(true)
      expect(() => assertCodexAccountId(id)).not.toThrow()
    }
  )

  it.each(['', '.', '..', 'a/b', '/absolute', '../escape', '.hidden', '-lead', 'space name', 'a\nb'])(
    'refuses traversal / unsafe id %j',
    (id) => {
      expect(isSafeAccountId(id)).toBe(false)
      expect(() => assertCodexAccountId(id)).toThrow('Invalid Codex account id')
    }
  )

  it('exposes the same regex the renderer validates against (one definition)', () => {
    expect(ACCOUNT_ID_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9._-]*$')
  })
})

describe('managed Codex account paths', () => {
  it('isolates two accounts under distinct homes and shared-server sockets', () => {
    const userData = '/isolated/nodeterm'
    expect(codexAccountHome(userData, 'account-a')).not.toBe(
      legacyCodexAccountHome(userData, 'account-a')
    )
    expect(codexHomeForAccount(userData, 'account-a')).not.toBe(
      codexHomeForAccount(userData, 'account-b')
    )
    expect(codexSocketForAccount(userData, 'account-a')).not.toBe(
      codexSocketForAccount(userData, 'account-b')
    )
  })

  it('folds userDataDir into the digest so separate profiles never collide', () => {
    expect(codexAccountHome('/profile-one', 'account-a')).not.toBe(
      codexAccountHome('/profile-two', 'account-a')
    )
  })

  it.each(['', '../escape', 'space name', '/absolute'])(
    'rejects unsafe account id %j at the home builder',
    (id) => {
      expect(() => codexAccountHome('/isolated/nodeterm', id)).toThrow('Invalid Codex account id')
    }
  )

  // A NON-EMPTY unsafe id reaches the socket builder through `codexAccountHome` and throws; an
  // empty id is the system account (falsy ⇒ `~/.codex`), which is the intended semantics.
  it.each(['../escape', 'space name', '/absolute'])(
    'rejects a non-empty unsafe account id %j at the socket builder',
    (id) => {
      expect(() => codexSocketForAccount('/isolated/nodeterm', id)).toThrow(
        'Invalid Codex account id'
      )
    }
  )

  it('treats an empty id as the system account, not a traversal', () => {
    expect(codexHomeForAccount('/isolated/nodeterm', '')).toBe(systemCodexHome())
    expect(codexSocketForAccount('/isolated/nodeterm', '')).toBe(
      path.join(systemCodexHome(), 'app-server-control', 'app-server-control.sock')
    )
  })

  it('system account resolves to $CODEX_HOME (absolute) or ~/.codex', () => {
    const prev = process.env.CODEX_HOME
    try {
      delete process.env.CODEX_HOME
      expect(systemCodexHome()).toBe(path.join(os.homedir(), '.codex'))
      expect(codexHomeForAccount('/isolated/nodeterm')).toBe(systemCodexHome())
      process.env.CODEX_HOME = 'relative-ignored'
      expect(systemCodexHome()).toBe(path.join(os.homedir(), '.codex'))
      process.env.CODEX_HOME = '/custom/codex'
      expect(systemCodexHome()).toBe('/custom/codex')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('keeps the managed daemon socket below macOS SUN_LEN', () => {
    const userData = '/Users/example/Library/Application Support/node-terminal'
    const accountId = 'be28d3d4-c18c-430c-a257-ae550d3dd7ed'
    expect(Buffer.byteLength(codexSocketForAccount(userData, accountId))).toBeLessThan(104)
  })
})

describe('per-session Codex env', () => {
  it('overwrites inherited account scope for system and managed sessions', () => {
    const accountHome = codexAccountHome('/isolated/nodeterm', 'account-a')
    expect(codexSessionEnv('/isolated/nodeterm')).toMatchObject({ NODETERM_CODEX_ACCOUNT_ID: '' })
    expect(codexSessionEnv('/isolated/nodeterm', 'account-a')).toEqual({
      CODEX_HOME: accountHome,
      NODETERM_CODEX_ACCOUNT_ID: 'account-a'
    })
    expect(codexTmuxEnvArgs('/isolated/nodeterm', 'account-a')).toEqual([
      '-e',
      `CODEX_HOME=${accountHome}`,
      '-e',
      'NODETERM_CODEX_ACCOUNT_ID=account-a'
    ])
  })

  it('scopes Codex agents and managed-id login terminals, nothing else', () => {
    expect(needsCodexAccountScope('codex')).toBe(true)
    expect(needsCodexAccountScope(undefined, 'account-a')).toBe(true)
    expect(needsCodexAccountScope(undefined, undefined)).toBe(false)
    expect(needsCodexAccountScope('bash')).toBe(false)
  })
})

describe('remote managed Codex homes', () => {
  it('isolates remote accounts under short host-local homes (digest over id only)', () => {
    const remoteHome = '/home/corvin'
    const first = remoteCodexHome(remoteHome, 'account-a')
    const second = remoteCodexHome(remoteHome, 'account-b')
    expect(first).not.toBe(second)
    expect(remoteCodexHome(remoteHome)).toBe('/home/corvin/.codex')
    expect(remoteCodexSocket(remoteHome, 'account-a')).toBe(
      `${first}/app-server-control/app-server-control.sock`
    )
    expect(remoteCodexTmuxEnvArgs(remoteHome, 'account-a')).toEqual([
      '-e',
      `CODEX_HOME=${first}`,
      '-e',
      'NODETERM_CODEX_ACCOUNT_ID=account-a'
    ])
  })

  it('rejects a relative remote home and unsafe account id', () => {
    expect(() => remoteCodexHome('relative', 'account-a')).toThrow('Remote home must be absolute')
    expect(() => remoteCodexHome('/home/corvin', '../escape')).toThrow('Invalid Codex account id')
  })
})

describe('legacy home migration (real fs, fail closed)', () => {
  it('moves an existing long managed home to its deterministic short home', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-home-'))
    try {
      const userData = path.join(fixture, 'Library', 'Application Support', 'node-terminal')
      const shortRoot = path.join(fixture, 'cx')
      const legacy = legacyCodexAccountHome(userData, 'account-a')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(path.join(legacy, 'auth.json'), 'fixture')

      const target = migrateLegacyCodexAccountHome(userData, 'account-a', shortRoot)

      expect(target).toBe(codexAccountHome(userData, 'account-a', shortRoot))
      expect(readFileSync(path.join(target, 'auth.json'), 'utf8')).toBe('fixture')
      expect(existsSync(legacy)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('never overwrites an existing short home', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-home-keep-'))
    try {
      const userData = path.join(fixture, 'ud')
      const shortRoot = path.join(fixture, 'cx')
      const legacy = legacyCodexAccountHome(userData, 'account-a')
      const target = codexAccountHome(userData, 'account-a', shortRoot)
      mkdirSync(legacy, { recursive: true })
      writeFileSync(path.join(legacy, 'auth.json'), 'legacy')
      mkdirSync(target, { recursive: true })
      writeFileSync(path.join(target, 'auth.json'), 'already-here')

      migrateLegacyCodexAccountHome(userData, 'account-a', shortRoot)

      expect(readFileSync(path.join(target, 'auth.json'), 'utf8')).toBe('already-here')
      expect(existsSync(legacy)).toBe(true)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('sweeps valid entries and leaves an invalid entry untouched (fail closed)', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-sweep-'))
    try {
      const userData = path.join(fixture, 'ud')
      const shortRoot = path.join(fixture, 'cx')
      const legacyRoot = path.join(userData, 'codex-accounts')
      const good = path.join(legacyRoot, 'account-a')
      const bad = path.join(legacyRoot, '.hidden') // fails ACCOUNT_ID_RE -> untouched
      mkdirSync(good, { recursive: true })
      mkdirSync(bad, { recursive: true })
      writeFileSync(path.join(good, 'auth.json'), 'good')
      writeFileSync(path.join(bad, 'auth.json'), 'bad')

      migrateLegacyCodexAccountHomes(userData, shortRoot)

      expect(existsSync(good)).toBe(false)
      expect(
        readFileSync(path.join(codexAccountHome(userData, 'account-a', shortRoot), 'auth.json'), 'utf8')
      ).toBe('good')
      // The invalid id never resolves to a short home and is left exactly where it was.
      expect(readFileSync(path.join(bad, 'auth.json'), 'utf8')).toBe('bad')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('is a no-op when there is no legacy root', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-noop-'))
    try {
      expect(() =>
        migrateLegacyCodexAccountHomes(path.join(fixture, 'ud'), path.join(fixture, 'cx'))
      ).not.toThrow()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('auth-env strip (no credential shadows the account login)', () => {
  it('lists the OpenAI/Codex key vars', () => {
    expect([...AUTH_ENV_STRIP]).toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY'])
  })

  it('removes exactly those vars and preserves the rest', () => {
    const stripped = stripCodexAuthEnv({
      OPENAI_API_KEY: 'sk-leak',
      CODEX_API_KEY: 'ck-leak',
      CODEX_HOME: '/home/.codex',
      PATH: '/usr/bin'
    })
    expect(stripped).toEqual({ CODEX_HOME: '/home/.codex', PATH: '/usr/bin' })
    expect('OPENAI_API_KEY' in stripped).toBe(false)
    expect('CODEX_API_KEY' in stripped).toBe(false)
  })
})

describe('usage discovery follows real homes, not the pending marker', () => {
  it('maps records to id/home/label/email regardless of pending', () => {
    expect(
      codexUsageAccounts(
        [{ id: 'account-a', label: 'Pending row', pending: true }],
        (id) => codexAccountHome('/isolated/nodeterm', id)
      )
    ).toEqual([
      {
        id: 'account-a',
        home: codexAccountHome('/isolated/nodeterm', 'account-a'),
        label: 'Pending row',
        email: undefined
      }
    ])
  })
})

describe('shared id predicate stays renderer-safe', () => {
  it('src/shared/codex-account imports nothing from src/core', () => {
    const src = readFileSync(path.join(__dirname, '..', 'shared', 'codex-account.ts'), 'utf8')
    expect(/from ['"](\.\.\/)*core\//.test(src)).toBe(false)
    expect(/from ['"]\.\/codex-accounts-core['"]/.test(src)).toBe(false)
  })
})
