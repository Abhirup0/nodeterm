import { describe, it, expect } from 'vitest'
import { SHELL_ACCESS_CONSENT, describeGrant, shellAccessConsent } from './consent'

describe('consent copy', () => {
  it('states shell access = SSH-equivalent, in plain words', () => {
    // The user must understand the grant BEFORE accepting — this is the whole point of the copy.
    expect(SHELL_ACCESS_CONSENT).toContain('run commands on this computer')
    expect(SHELL_ACCESS_CONSENT).toContain('the same as giving them SSH access')
  })

  it('names the peer', () => {
    expect(describeGrant('Ayşe')).toBe(
      'Ayşe will be able to run commands on this computer — the same as giving them SSH access.'
    )
  })

  it('falls back to a generic subject when the label is empty/blank', () => {
    expect(describeGrant('')).toBe(SHELL_ACCESS_CONSENT)
    expect(describeGrant('   ')).toBe(SHELL_ACCESS_CONSENT)
    expect(describeGrant('  Bora ')).toBe(
      'Bora will be able to run commands on this computer — the same as giving them SSH access.'
    )
  })

  // Issue #563: this module is SHARED, so it cannot ask the renderer what this OS calls its
  // machine — the caller names it, and the default is the neutral word rather than "this Mac"
  // on a Windows box being asked to hand out shell access.
  it('lets the caller name the machine, on both the named and the no-name sentence', () => {
    expect(describeGrant('Ayşe', 'this PC')).toBe(
      'Ayşe will be able to run commands on this PC — the same as giving them SSH access.'
    )
    expect(describeGrant('', 'this PC')).toBe(shellAccessConsent('this PC'))
    expect(shellAccessConsent('this PC')).toContain('run commands on this PC')
  })
})
