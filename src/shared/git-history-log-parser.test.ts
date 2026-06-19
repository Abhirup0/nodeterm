import { describe, expect, it } from 'vitest'
import { parseGitHistoryLog, shortGitHash } from './git-history-log-parser'

describe('parseGitHistoryLog', () => {
  it('parses one NUL-delimited record with refs', () => {
    const hash = 'a'.repeat(40)
    const record = [
      hash,
      'Jane Dev',
      'jane@example.com',
      '1700000000',
      '1700000005',
      'b'.repeat(40),
      'HEAD -> refs/heads/main\x1frefs/remotes/origin/main\x1ftag: refs/tags/v1',
      'Subject line\n\nBody text'
    ].join('\n')
    const [item] = parseGitHistoryLog(record + '\0')
    expect(item.id).toBe(hash)
    expect(item.subject).toBe('Subject line')
    expect(item.parentIds).toEqual(['b'.repeat(40)])
    expect(item.author).toBe('Jane Dev')
    expect(item.references?.map((r) => r.name)).toEqual(['main', 'origin/main', 'v1'])
  })

  it('skips blank records and short hashes', () => {
    expect(parseGitHistoryLog('\0not-a-hash\n\0')).toEqual([])
  })

  it('shortens hashes to 7 chars', () => {
    expect(shortGitHash('abcdef1234567')).toBe('abcdef1')
  })
})
