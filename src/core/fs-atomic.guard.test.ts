// Two rules, both about temp-then-rename, both invisible for the life of the project:
//   1. no store publishes with a bare rename (any spelling) — the Windows data-loss bug;
//   2. no local `.tmp` publisher builds a name two writers can share — the corruption bug beside it.
//
// Twenty-eight files wrote temp-then-rename, which is correct on POSIX and silently lossy on Windows: the rename
// fails with EPERM whenever anything has the destination open, and the things that open a file we
// just wrote are Defender, the search indexer, OneDrive, and our own concurrent writers. See
// `fs-atomic.ts` for the full account.
//
// Nothing caught it. Every one of those files was reviewed, several were security-reviewed, and the
// only signal in the entire suite was one store's concurrency test — which had been failing on
// Windows for as long as the store existed and passing everywhere else. A reviewer reading any
// individual file sees a correct atomic write, because on the platform most of this was written on
// it IS one.
//
// So the rule is enforced by scan rather than by memory: a new store added next year gets the
// retry because this test refuses the alternative, not because its author had read this file.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOTS = ['core', 'main', 'server', 'session-host'].map((d) => join(__dirname, '..', d))
const SOURCE_ROOT = join(__dirname, '..')

/** Guard comparisons use one separator regardless of the host running Vitest. */
function normalizedSourcePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function sourceRelativePath(file: string): string {
  return normalizedSourcePath(relative(SOURCE_ROOT, file))
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') sources(p, out)
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

/**
 * Files allowed to call `fs.rename` directly, each with the reason.
 *
 * Kept deliberately short. Every entry is a place the retry does not apply, not a place somebody
 * did not get round to — an exemption that means "later" belongs in an issue, not here.
 */
const RENAME_ALLOWED = new Map<string, string>([
  ['core/fs-atomic.ts', 'the async/core helper; this is its one real rename'],
  [
    'session-host/state-file.ts',
    'the standalone host cannot import core; this helper owns its bounded synchronous rename retry'
  ]
])

function isRenameAllowed(relativeFile: string): boolean {
  return RENAME_ALLOWED.has(normalizedSourcePath(relativeFile))
}

describe('every store publishes through renameAtomic', () => {
  const files = ROOTS.flatMap((r) => sources(r))

  it('finds the source tree (a zero-file scan would pass silently)', () => {
    // The failure this whole file is about, one level up: a scan that matches nothing reports
    // clean. If a directory is renamed and this drops to nothing, it must go red, not quiet.
    expect(files.length).toBeGreaterThan(100)
  })

  // Every spelling of the call, because the first version of this test knew only `fs.rename(` and
  // went GREEN over eight real offenders — including `atomic-json-store.ts`, a file whose name is
  // the thing it was failing to do. A guard that matches one spelling of a hazard is worse than
  // none: it converts "nobody has checked" into "this has been checked", which is what stops the
  // next person looking.
  //
  //   fs.rename(…)            the namespace import
  //   renameSync(…)           the sync variant, on startup and hook-install paths
  //   rename(tmp, …)          destructured from 'node:fs/promises'
  //
  // `renameAtomic`/`renameAtomicSync` must not match, hence the trailing `\s*\(` and the
  // preceding-character guards.
  interface FsRenameBindings {
    namespaces: Set<string>
    asyncCalls: Set<string>
    syncCalls: Set<string>
  }

  const FS_MODULE = /^(node:)?fs(\/promises)?$/
  const identifier = /^[A-Za-z_$][\w$]*$/
  const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /** Resolve the LOCAL bindings imported from fs. Hard-coding `fs`/`fsp` let a harmless alias
   * change (`import nodeFs ...`) turn the guard green over the same dangerous call. */
  function fsRenameBindings(text: string): FsRenameBindings {
    const found: FsRenameBindings = {
      namespaces: new Set(),
      asyncCalls: new Set(),
      syncCalls: new Set()
    }
    for (const match of text.matchAll(
      /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g
    )) {
      if (FS_MODULE.test(match[2])) found.namespaces.add(match[1])
    }
    for (const match of text.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      if (!FS_MODULE.test(match[2])) continue
      for (const rawMember of match[1].split(',')) {
        const promises = rawMember
          .trim()
          .match(/^promises(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
        if (promises && !/\/promises$/.test(match[2])) {
          found.namespaces.add(promises[1] ?? 'promises')
          continue
        }
        const member = rawMember.trim().match(/^(rename|renameSync)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
        if (!member) continue
        const local = member[2] ?? member[1]
        if (!identifier.test(local)) continue
        ;(member[1] === 'rename' ? found.asyncCalls : found.syncCalls).add(local)
      }
    }
    // TypeScript sources occasionally retain CommonJS imports at process boundaries. They get
    // the same alias resolution rather than becoming a quiet escape hatch.
    for (const match of text.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g
    )) {
      if (FS_MODULE.test(match[2])) found.namespaces.add(match[1])
    }
    return found
  }

  function renameHits(text: string): string[] {
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/import\s*[\s\S]*?\s+from\s*['"][^'"]+['"]/g, '')
    const bindings = fsRenameBindings(text)
    const hits: string[] = []
    for (const namespace of bindings.namespaces) {
      const call = new RegExp(
        `(?<![A-Za-z0-9_$.])${escaped(namespace)}(?:\\.promises)?\\.rename(?:Sync)?\\s*\\(`
      )
      if (call.test(code)) hits.push(`${namespace}.rename`)
    }
    for (const local of [...bindings.asyncCalls, ...bindings.syncCalls]) {
      const call = new RegExp(`(?<![A-Za-z0-9_$.])${escaped(local)}\\s*\\(`)
      if (call.test(code)) hits.push(`${local}(`)
    }
    return hits
  }

  it('no bare rename, in ANY spelling, outside the helper', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const rel = sourceRelativePath(f)
      if (isRenameAllowed(rel)) continue
      const hits = renameHits(text)
      if (hits.length) offenders.push(`${rel}  [${hits.join(', ')}]`)
    }
    expect(
      offenders,
      'these publish a file with a bare rename, which loses the write on Windows whenever the ' +
        'destination is momentarily open — use renameAtomic/renameAtomicSync from core/fs-atomic.ts'
    ).toEqual([])
  })

  it('the guard would actually catch each spelling', () => {
    // Proving the needles bite, on strings rather than by breaking real files.
    expect(renameHits("import fs from 'fs'\nawait fs.rename(a, b)")).not.toEqual([])
    expect(renameHits("import nodeFs from 'node:fs'\nnodeFs.renameSync(a, b)")).not.toEqual([])
    expect(renameHits("import fs from 'fs'\nawait fs.promises.rename(a, b)")).not.toEqual([])
    expect(renameHits("import { promises as disk } from 'node:fs'\nawait disk.rename(a, b)"))
      .not.toEqual([])
    expect(renameHits("import { renameSync } from 'fs'\nrenameSync(tmp, file)")).not.toEqual([])
    expect(renameHits("import { rename as move } from 'node:fs/promises'\nawait move(a, b)")).not.toEqual([])
    expect(renameHits("const disk = require('fs')\ndisk.renameSync(a, b)")).not.toEqual([])
    // …and that the replacements do NOT trip it. `renameAtomic` contains `rename`, so this is the
    // assertion standing between the guard and flagging every file it just fixed.
    expect(renameHits("import { renameAtomic } from './fs-atomic'\nawait renameAtomic(a, b)"))
      .toEqual([])
    expect(renameHits("import { renameAtomicSync } from './fs-atomic'\nrenameAtomicSync(a, b)"))
      .toEqual([])
  })

  it('the fs-import qualifier separates a real rename from a method called rename', () => {
    // The false positives that made this necessary were all real: kids-mode, School-mode and the
    // Ollama chat store each expose a `rename()` of their own.
    const fsImport = "import { mkdir, rename, writeFile } from 'node:fs/promises'"
    expect([...fsRenameBindings(fsImport).asyncCalls]).toEqual(['rename'])
    expect([...fsRenameBindings("import { renameSync } from 'fs'").syncCalls]).toEqual(['renameSync'])
    expect(fsRenameBindings("import { mkdir, writeFile } from 'node:fs/promises'").asyncCalls.size)
      .toBe(0)
    // Not from fs at all — a store's own method, or a helper of the same name.
    expect(fsRenameBindings("import { rename } from './my-store'").asyncCalls.size).toBe(0)
    // Must not be satisfied by a longer member that merely contains the name.
    expect(fsRenameBindings("import { renameAtomic } from './fs-atomic'").asyncCalls.size).toBe(0)
    expect(fsRenameBindings("import { renameSync } from 'fs'").asyncCalls.size).toBe(0)
  })

  it('normalizes helper exemptions on both POSIX and Windows-shaped paths', () => {
    expect(normalizedSourcePath('core/fs-atomic.ts')).toBe('core/fs-atomic.ts')
    expect(normalizedSourcePath(String.raw`core\fs-atomic.ts`)).toBe('core/fs-atomic.ts')
    expect(isRenameAllowed('core/fs-atomic.ts')).toBe(true)
    expect(isRenameAllowed(String.raw`core\fs-atomic.ts`)).toBe(true)
    expect(isRenameAllowed('session-host/state-file.ts')).toBe(true)
    expect(isRenameAllowed(String.raw`session-host\state-file.ts`)).toBe(true)
    expect(isRenameAllowed('nested/core/fs-atomic.ts')).toBe(false)
    expect(isRenameAllowed('nested/session-host/state-file.ts')).toBe(false)
    expect(isRenameAllowed('core/fs-atomic.ts.bak')).toBe(false)
    expect(isRenameAllowed('session-host/state-file.ts.bak')).toBe(false)
    const scanned = new Set(files.map(sourceRelativePath))
    for (const allowed of RENAME_ALLOWED.keys()) expect(scanned.has(allowed)).toBe(true)
  })
})

describe('no local .tmp publisher uses a shared temp name', () => {
  const files = ROOTS.flatMap((r) => sources(r))

  it('every local temp path carries random UUID entropy', () => {
    // The second bug at the same sites, independent of the platform question: a FIXED temp name
    // means two writers share one path, so one rename publishes the other's half-written bytes —
    // or moves the temp out from under it, and the loser fails with a confusing ENOENT.
    //
    // Five sites had it, and each had a reason it was thought safe: "only one instance exists",
    // "the write queue serializes this". Every one of those was true within one PROCESS and
    // silent about a second. The Server Edition takes a --data-dir, so two can be aimed at one
    // directory; scrollback-store had a counter and no pid, which is that gap exactly.
    //
    // Deliberately NOT "must call tempNameFor": an inline randomUUID name is also correct. The
    // rule is the collision-resistant property, not one spelling of the helper call.
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const rel = sourceRelativePath(f)
      for (const name of tempNameExpressions(text)) {
        if (isUniqueTempName(name, rel, text)) continue
        offenders.push(`${rel}  \`${name}\``)
      }
    }
    expect(
      offenders,
      'these build a temp path two writers can share — use tempNameFor() from core/fs-atomic.ts, ' +
        'and remember a unique name must be cleaned up on failure because it never self-heals ' +
        'the way a fixed one did'
    ).toEqual([])
  })

  it('the needle tells a shared name from a safe one', () => {
    expect(tempNameExpressions('  const tmp = `${this.path}.tmp`')).toHaveLength(1)
    expect(tempNameExpressions('  const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`')).toHaveLength(1)
    expect(tempNameExpressions('  const tmp = path.join(dir, `.${nodeId}.${process.pid}.${Date.now()}.tmp`)')).toHaveLength(1)
    expect(tempNameExpressions('  const tmp = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)')).toHaveLength(1)
    expect(tempNameExpressions('  return `${target}.${pid}.${sequence}.${uuid()}.tmp`')).toHaveLength(1)
    expect(tempNameExpressions(
      '  const tmp: string = path.join(\n    dir,\n    `${file}.${Date.now()}.tmp`\n  )'
    )).toEqual(['${file}.${Date.now()}.tmp'])
    expect(tempNameExpressions("  const tmp = file + '.tmp'")).toEqual(["file + '.tmp'"])
    expect(tempNameExpressions("  const tmp =\n    file +\n    '.tmp'"))
      .toEqual(["file + '.tmp'"])
    const importsUuid = "import { randomUUID } from 'crypto'"
    const importsUuidAlias = "import { randomUUID as freshId } from 'node:crypto'"
    const importsDefaultCrypto = "import crypto from 'node:crypto'"
    const importsNamespaceCrypto = "import * as entropy from 'crypto'"
    expect(isUniqueTempName('${this.path}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName(
      '${file}.${process.pid}.${++writeSeq}.${randomUUID()}.tmp',
      'core/store.ts',
      importsUuid
    )).toBe(true)
    expect(isUniqueTempName(
      '${file}.${process.pid}.${++this.writeSeq}.${uuid()}.tmp',
      'core/fs-atomic.ts',
      ''
    )).toBe(true)
    expect(isUniqueTempName('${file}.${Date.now()}-${randomUUID()}.tmp', 'core/store.ts', importsUuid))
      .toBe(true)
    expect(isUniqueTempName(
      '${file}.${freshId()}.tmp',
      'core/store.ts',
      importsUuidAlias
    )).toBe(true)
    expect(isUniqueTempName(
      '${file}.${crypto.randomUUID()}.tmp',
      'server/upload.ts',
      importsDefaultCrypto
    )).toBe(true)
    expect(isUniqueTempName(
      '${file}.${entropy.randomUUID()}.tmp',
      'server/upload.ts',
      importsNamespaceCrypto
    )).toBe(true)
    expect(isUniqueTempName(
      '${file}.${diskEntropy.randomUUID()}.tmp',
      'server/upload.ts',
      "const diskEntropy = require('node:crypto')"
    )).toBe(true)
    expect(isUniqueTempName(
      '${file}.${freshId()}.tmp',
      'server/upload.ts',
      "const { randomUUID: freshId } = require('crypto')"
    )).toBe(true)
    // A function merely NAMED uuid/randomUUID is not entropy. Only the two helpers may use their
    // behavior-tested injected uuid seam; inline sites must call a binding imported from crypto.
    expect(isUniqueTempName('${file}.${uuid()}.tmp', 'core/other.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${randomUUID()}.tmp', 'core/other.ts', '')).toBe(false)
    expect(isUniqueTempName(
      '${file}.${crypto.randomUUID()}.tmp',
      'core/other.ts',
      "import crypto from './crypto'"
    )).toBe(false)
    expect(isUniqueTempName(
      '${file}.${fake.randomUUID()}.tmp',
      'core/other.ts',
      importsUuid
    )).toBe(false)
    expect(isUniqueTempName(
      '${file}.${randomUUID()}.tmp',
      'core/other.ts',
      importsNamespaceCrypto
    )).toBe(false)
    expect(isUniqueTempName(
      '${file}.${crypto.randomUUID}.tmp',
      'core/other.ts',
      importsDefaultCrypto
    )).toBe(false)
    expect(isUniqueTempName(
      '${file}.${crypto.randomUUID()}.tmp',
      'core/other.ts',
      "const crypto = { randomUUID: () => 'fixed' }"
    )).toBe(false)
    expect(isUniqueTempName(
      '${file}.${"crypto.randomUUID("}.tmp',
      'core/other.ts',
      importsDefaultCrypto
    )).toBe(false)
    expect(isUniqueTempName(
      '${file}.${crypto.randomUUID()}.tmp',
      'core/other.ts',
      "// import crypto from 'node:crypto'"
    )).toBe(false)
    // A clock tick is shared by every writer in that millisecond. A pid only separates processes;
    // neither one separates two calls in the same process.
    expect(isUniqueTempName('${file}.${Date.now()}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${process.pid}.${Date.now()}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.tmp-${process.pid}-${Date.now()}', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${process.pid}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${++writeSeq}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${process.pid}.${writeSeq}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${process.pid}.${++writeSeq}.tmp', 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName('${file}.${process.pid}.${writeSeq++ % 2}.tmp', 'core/store.ts', ''))
      .toBe(false)
    expect(isUniqueTempName("file + '.tmp'", 'core/store.ts', '')).toBe(false)
    expect(isUniqueTempName(
      "file + '.' + randomUUID() + '.tmp'",
      'core/store.ts',
      importsUuid
    )).toBe(true)
  })
})

/** Find temp-path templates returned by a helper or assigned directly/through path.join, including
 * typed/multiline joins and the common `tmp = file + '.tmp'` concatenation. Each join is bounded
 * by its semicolon/backtick and each concatenation by its declaration line, so an unrelated later
 * string cannot become false entropy. The historical node-token collision lived inside path.join;
 * the old direct-only needle silently missed it. */
function tempNameExpressions(text: string): string[] {
  const templates = [...text.matchAll(
    /^\s*(?:(?:const|let)\s+\w+(?:\s*:\s*[^=;\r\n]+)?\s*=\s*(?:(?:path\.)?join\([^`;]*?)?|return\s+)`([^`]*(?:\.tmp|tmp-)[^`]*)`/gm
  )].map((match) => match[1])
  const concatenations: string[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const declaration = /^\s*(?:const|let)\s+\w*(?:tmp|temp)\w*(?:\s*:\s*[^=]+)?\s*=\s*(.*)$/i
      .exec(lines[index])
    if (!declaration) continue
    let expression = declaration[1]
    let next = index + 1
    const continues = (): boolean => {
      const compact = expression.trim()
      const opens = (expression.match(/[([{]/g) ?? []).length
      const closes = (expression.match(/[)\]}]/g) ?? []).length
      return compact === '' || /[+,(]$/.test(compact) || opens > closes || /^\s*\+/.test(lines[next] ?? '')
    }
    while (next < lines.length && continues()) {
      expression += ` ${lines[next].trim()}`
      next++
    }
    if (/['"][^'"]*(?:\.tmp|tmp-)[^'"]*['"]/.test(expression)) {
      concatenations.push(expression.trim().replace(/\s+/g, ' '))
      index = next - 1
    }
  }
  return [...templates, ...concatenations]
}

interface CryptoRandomUuidBindings {
  namespaces: Set<string>
  directCalls: Set<string>
}

const CRYPTO_MODULE = /^(node:)?crypto$/
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve only bindings that come from Node's crypto module. Matching the call spelling alone
 * let an unrelated object named `crypto` or `fake.randomUUID()` satisfy the uniqueness guard. */
function cryptoRandomUuidBindings(source: string): CryptoRandomUuidBindings {
  const found: CryptoRandomUuidBindings = {
    namespaces: new Set(),
    directCalls: new Set()
  }

  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  for (const match of code.matchAll(
    /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm
  )) {
    if (!CRYPTO_MODULE.test(match[2])) continue
    const clause = match[1].trim()
    if (/^type\b/.test(clause)) continue

    const defaultImport = clause.match(/^([A-Za-z_$][\w$]*)(?:\s*,|$)/)
    if (defaultImport) found.namespaces.add(defaultImport[1])

    const namespaceImport = clause.match(/(?:^|,)\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s*$/)
    if (namespaceImport) found.namespaces.add(namespaceImport[1])

    const namedImports = clause.match(/\{([\s\S]*?)\}/)
    if (!namedImports) continue
    for (const rawMember of namedImports[1].split(',')) {
      const member = rawMember.trim().match(
        /^randomUUID(?:\s+as\s+([A-Za-z_$][\w$]*))?$/
      )
      const local = member?.[1] ?? (member ? 'randomUUID' : '')
      if (IDENTIFIER.test(local)) found.directCalls.add(local)
    }
  }

  for (const match of code.matchAll(
    /^\s*import\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm
  )) {
    if (CRYPTO_MODULE.test(match[2])) found.namespaces.add(match[1])
  }

  // A few process-boundary files retain CommonJS imports. They get the same binding check rather
  // than turning `require('crypto')` into a quiet false-red or an arbitrary local alias green.
  for (const match of code.matchAll(
    /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm
  )) {
    if (CRYPTO_MODULE.test(match[2])) found.namespaces.add(match[1])
  }
  for (const match of code.matchAll(
    /^\s*(?:const|let)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm
  )) {
    if (!CRYPTO_MODULE.test(match[2])) continue
    for (const rawMember of match[1].split(',')) {
      const member = rawMember.trim().match(
        /^randomUUID(?:\s*:\s*([A-Za-z_$][\w$]*))?$/
      )
      const local = member?.[1] ?? (member ? 'randomUUID' : '')
      if (IDENTIFIER.test(local)) found.directCalls.add(local)
    }
  }

  return found
}

/** A random UUID is the unique dimension. PID+counter is valuable ownership metadata, but two
 * containers can both be PID 1 with a fresh module counter, worker isolates share a PID with
 * separate counters, and an OS can reuse a PID while crash litter remains. */
function isUniqueTempName(name: string, relativeFile: string, source: string): boolean {
  const helperWithBehavioralUuidChut =
    relativeFile === 'core/fs-atomic.ts' || relativeFile === 'session-host/state-file.ts'
  const bindings = cryptoRandomUuidBindings(source)
  const interpolationBodies = [...name.matchAll(/\$\{([^}]*)\}/g)].map((match) =>
    match[1]
      .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/g, '')
  )
  const inspectedBodies = interpolationBodies.length > 0
    ? interpolationBodies
    : [name
        .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/g, '')]

  if (helperWithBehavioralUuidChut) {
    if (inspectedBodies.some((body) => /(?<![A-Za-z0-9_$.])uuid\s*\(/.test(body))) {
      return true
    }
  }
  for (const namespace of bindings.namespaces) {
    const call = new RegExp(
      `(?<![A-Za-z0-9_$.])${escapeRegExp(namespace)}\\.randomUUID\\s*\\(`
    )
    if (inspectedBodies.some((body) => call.test(body))) return true
  }
  for (const directCall of bindings.directCalls) {
    const call = new RegExp(`(?<![A-Za-z0-9_$.])${escapeRegExp(directCall)}\\s*\\(`)
    if (inspectedBodies.some((body) => call.test(body))) return true
  }
  return false
}
