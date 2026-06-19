import { describe, expect, it } from 'vitest'
import { loadGitHistoryFromExecutor, GIT_HISTORY_COMMIT_FORMAT } from './git-history'

function makeGit(responses: Record<string, string>) {
  return async (args: string[]) => {
    const key = args.join(' ')
    for (const prefix of Object.keys(responses)) {
      if (key.startsWith(prefix)) return { stdout: responses[prefix] }
    }
    throw new Error(`unexpected git ${key}`)
  }
}

describe('loadGitHistoryFromExecutor', () => {
  it('returns empty items when there is no HEAD', async () => {
    const git = async () => { throw new Error('no head') }
    const result = await loadGitHistoryFromExecutor(git, '/repo')
    expect(result.items).toEqual([])
    expect(result.hasIncomingChanges).toBe(false)
  })

  it('parses HEAD history with a branch ref', async () => {
    const head = 'c'.repeat(40)
    const record = [head, 'Dev', 'd@e.f', '1700000000', '1700000000', '', 'HEAD -> refs/heads/main', 'Init'].join('\n')
    const git = makeGit({
      'rev-parse --verify --end-of-options HEAD': head,
      'symbolic-ref --quiet --short HEAD': 'main',
      'for-each-ref': '',
      'rev-parse --symbolic-full-name': '',
      'log': record + '\0'
    })
    const result = await loadGitHistoryFromExecutor(git, '/repo', { limit: 10 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.subject).toBe('Init')
    expect(result.currentRef?.name).toBe('main')
  })

  it('uses the documented commit format', () => {
    expect(GIT_HISTORY_COMMIT_FORMAT).toContain('%H%n')
  })
})
