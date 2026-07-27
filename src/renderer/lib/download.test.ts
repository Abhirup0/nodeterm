import { describe, it, expect } from 'vitest'
import { canRevealLocally, downloadRoute } from './download'

describe('downloadRoute', () => {
  it('pulls an SSH project over scp on the desktop', () => {
    expect(downloadRoute({ browser: false, ssh: true, source: 'local' })).toBe('scp')
  })

  it('serves every browser tree over HTTP — including a "local" project, which is on the server', () => {
    expect(downloadRoute({ browser: true, ssh: false, source: 'local' })).toBe('http')
  })

  it('offers nothing for a desktop local project (the file is already here)', () => {
    expect(downloadRoute({ browser: false, ssh: false, source: 'local' })).toBe('none')
  })

  it('offers nothing on a relay tab, whatever the project is', () => {
    expect(downloadRoute({ browser: false, ssh: true, source: 'relay' })).toBe('none')
    expect(downloadRoute({ browser: true, ssh: false, source: 'relay' })).toBe('none')
  })

  it('does not mint a ticket for an SSH tree in the browser (that fs is not the server’s)', () => {
    expect(downloadRoute({ browser: true, ssh: true, source: 'local' })).toBe('none')
  })
})

describe('canRevealLocally', () => {
  it('is true only for a desktop local project', () => {
    expect(canRevealLocally({ browser: false, ssh: false, source: 'local' })).toBe(true)
  })

  it('is false where the path is not on this machine, or nothing can open it', () => {
    expect(canRevealLocally({ browser: false, ssh: true, source: 'local' })).toBe(false)
    expect(canRevealLocally({ browser: true, ssh: false, source: 'local' })).toBe(false)
    expect(canRevealLocally({ browser: false, ssh: false, source: 'relay' })).toBe(false)
  })
})
