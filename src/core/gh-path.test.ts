import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ghPath, _resetGhPathForTest } from './gh-path'
import * as execPath from './exec-path'

describe('ghPath', () => {
  beforeEach(() => {
    _resetGhPathForTest()
    vi.restoreAllMocks()
  })

  it('memoizes on hit so repeated calls do not re-probe', () => {
    const spy = vi.spyOn(execPath, 'findExecutableSync').mockReturnValue('/usr/local/bin/gh')

    expect(ghPath()).toBe('/usr/local/bin/gh')
    expect(ghPath()).toBe('/usr/local/bin/gh')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not memoize on miss so a newly installed gh is picked up', () => {
    const spy = vi.spyOn(execPath, 'findExecutableSync')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('/opt/homebrew/bin/gh')

    expect(ghPath()).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)

    expect(ghPath()).toBe('/opt/homebrew/bin/gh')
    expect(spy).toHaveBeenCalledTimes(2)

    // Now cached because it was a hit
    expect(ghPath()).toBe('/opt/homebrew/bin/gh')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('probes with common bin dirs fallbacks', () => {
    const spy = vi.spyOn(execPath, 'findExecutableSync').mockReturnValue('/usr/bin/gh')

    expect(ghPath()).toBe('/usr/bin/gh')
    expect(spy).toHaveBeenCalledWith('gh', [
      '/opt/homebrew/bin/gh',
      '/usr/local/bin/gh',
      '/usr/bin/gh'
    ])
  })
})
