import { describe, it, expect } from 'vitest'
import { classifyPaneCwd } from './pane-cwd'

const exists = (): boolean => true
const missing = (): boolean => false

describe('classifyPaneCwd (issue #464 — stale cwd after delete/recreate)', () => {
  it('a live directory is ok', () => {
    expect(classifyPaneCwd('/home/user/project', exists, 'linux')).toBe('ok')
    expect(classifyPaneCwd('/home/user/project', exists, 'darwin')).toBe('ok')
  })

  it('the Linux "(deleted)" readlink suffix is stale — even when a same-named dir exists again', () => {
    // MEASURED (tmux 3.4, Linux): after `rm -rf dir && mkdir dir`, `#{pane_current_path}` still
    // reports `dir (deleted)` — the readlink names the inode the shell holds, not the path. The
    // recreated directory existing must NOT launder the verdict, so `exists` answers true here.
    expect(classifyPaneCwd('/home/user/project (deleted)', exists, 'linux')).toBe('stale')
  })

  it('a reported path that is gone from disk is stale (deleted, not yet recreated)', () => {
    expect(classifyPaneCwd('/home/user/project', missing, 'linux')).toBe('stale')
    expect(classifyPaneCwd('/home/user/project', missing, 'darwin')).toBe('stale')
  })

  it('an empty answer is stale ONLY on darwin', () => {
    // darwin: proc_pidinfo cannot name an unlinked cwd vnode, so tmux answers empty (inferred
    // from tmux's osdep-darwin.c — the PR's device checklist owes the on-device measurement).
    expect(classifyPaneCwd('', exists, 'darwin')).toBe('stale')
    // Elsewhere, empty means "tmux could not say" (an osdep with no cwd reader, a transient
    // tcgetpgrp failure). Flagging every terminal on such a platform would be a wrong fact on
    // screen, so the verdict degrades to nothing.
    expect(classifyPaneCwd('', exists, 'linux')).toBe('unknown')
    expect(classifyPaneCwd('', exists, 'freebsd')).toBe('unknown')
  })

  it('a non-absolute answer is unknown, never judged', () => {
    expect(classifyPaneCwd('not a path', missing, 'linux')).toBe('unknown')
  })

  it('a path ending in spaces is judged as-is (no trimming)', () => {
    let asked = ''
    const record = (p: string): boolean => {
      asked = p
      return true
    }
    expect(classifyPaneCwd('/tmp/dir with trailing  ', record, 'linux')).toBe('ok')
    expect(asked).toBe('/tmp/dir with trailing  ')
  })

  it('a throwing-free contract: dirExists is only consulted for plain absolute paths', () => {
    // The "(deleted)" branch never stats — the suffix IS the verdict, and statting the suffixed
    // string would be statting a name that never existed.
    const boom = (): boolean => {
      throw new Error('must not be called')
    }
    expect(classifyPaneCwd('/x (deleted)', boom, 'linux')).toBe('stale')
    expect(classifyPaneCwd('', boom, 'darwin')).toBe('stale')
  })
})
