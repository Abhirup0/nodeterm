import { describe, expect, it } from 'vitest'
import { readSpawnResources, spawnResourceNote } from './spawn-resources'

/**
 * The 2026-08-06 report: terminals failing with `posix_spawnp failed.` and 33 live PTYs, on a
 * message that advised restarting the app or rebuilding node-pty for the wrong architecture. Both
 * are real causes, both are rare, and the message said it every time — so the diagnosis went to the
 * architecture, which was fine.
 *
 * node-pty discards the errno, so the numbers below are the closest thing to one. What is pinned
 * here is that a remedy is only named when the measurement supports it.
 */
describe('spawnResourceNote', () => {
  it('states what it counted', () => {
    const note = spawnResourceNote({ openFds: 120, fdSoft: 256, procSoft: 2000 }, 33)
    expect(note).toContain('live PTYs: 33')
    expect(note).toContain('open files: 120/256')
  })

  it('names the file-descriptor limit ONLY when the process is against it', () => {
    const healthy = spawnResourceNote({ openFds: 120, fdSoft: 256, procSoft: null }, 33)
    expect(healthy).not.toContain('FILE DESCRIPTOR')

    const exhausted = spawnResourceNote({ openFds: 254, fdSoft: 256, procSoft: null }, 33)
    expect(exhausted).toContain('FILE DESCRIPTOR')
    // …and the remedy has to follow from the number, not from habit: a restart frees the
    // descriptors and they fill again, so it is the wrong advice even though it "works".
    expect(exhausted).toContain('close some terminals')
  })

  it('counts "a handful below the ceiling" as against it', () => {
    // A spawn needs several descriptors at once, so the failure lands before the count is equal.
    expect(spawnResourceNote({ openFds: 245, fdSoft: 256, procSoft: null }, 1)).toContain(
      'FILE DESCRIPTOR'
    )
  })

  it('says nothing it could not measure, rather than inventing a figure', () => {
    const note = spawnResourceNote({ openFds: null, fdSoft: null, procSoft: null }, 7)
    expect(note).toBe('live PTYs: 7')
    expect(note).not.toContain('FILE DESCRIPTOR')
  })

  it('reports a known limit even with no count to compare it against', () => {
    expect(spawnResourceNote({ openFds: null, fdSoft: 256, procSoft: null }, 7)).toContain(
      'file limit: 256'
    )
  })
})

describe('readSpawnResources', () => {
  it('measures this process without throwing', () => {
    // It runs INSIDE an error path: a diagnostic that throws replaces a bad error message with no
    // error message. The values themselves are the machine's, so only their shape is asserted.
    const r = readSpawnResources()
    expect(r.openFds === null || r.openFds > 0).toBe(true)
    expect(r.fdSoft === null || r.fdSoft > 0).toBe(true)
    expect(r.procSoft === null || r.procSoft > 0).toBe(true)
  })
})
