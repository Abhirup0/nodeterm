import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard for the macOS hardened-runtime entitlements the production main
 * executable is signed with (build/entitlements.mac.plist, wired via the
 * package.json `build.mac.entitlements` + `entitlementsInherit` keys).
 *
 * WHY THIS EXISTS: a private report (Fortress MSSP, 2026-08-23) confirmed that on
 * an arm64 host a same-user, post-compromise attacker could launch the exact
 * shipped, Developer-ID-signed, notarized nodeterm executable with
 * `DYLD_INSERT_LIBRARIES` pointing at a foreign ad-hoc-signed dylib, and its
 * constructor ran INSIDE the vendor-signed process before application main. The
 * enabling condition was the entitlement PAIR
 * `com.apple.security.cs.allow-dyld-environment-variables` +
 * `com.apple.security.cs.disable-library-validation`; matched controls confirmed
 * neither alone reproduced it. Foreign pre-main code running with nodeterm's own
 * code identity matters here specifically because macOS Keychain ACLs gate
 * access by the requesting binary's identity, and the app uses Electron
 * `safeStorage` (Keychain-backed) for GitHub / model-gateway secrets, the
 * node-auth root secret, and remote host identity material.
 *
 * `com.apple.security.cs.allow-dyld-environment-variables` is REMOVED because no
 * code in this app reads DYLD_* in the main process — the only reference is in
 * `src/core/claude-accounts-core.ts`, which STRIPS DYLD_* out of spawned child
 * agent processes (the opposite direction). Removing it closes the demonstrated
 * injection vector at zero functional cost.
 *
 * This test reads the plist rather than measuring a signed binary, so it runs on
 * the ubuntu CI runner (`npm test`) on every PR/push — the release-CI assertion
 * the report asked for.
 */
const ENTITLEMENTS = path.resolve(__dirname, '../../build/entitlements.mac.plist')

const HOWTO =
  'A macOS main-process entitlement that permits pre-main code injection into the ' +
  'signed, notarized production process must not ship. See the Fortress MSSP report ' +
  '(2026-08-23) and the reasoning in this test file.'

describe('macOS production entitlements', () => {
  const exists = fs.existsSync(ENTITLEMENTS)
  const plist = exists ? fs.readFileSync(ENTITLEMENTS, 'utf8') : ''

  it('build/entitlements.mac.plist exists', () => {
    expect(exists, `Missing ${ENTITLEMENTS}`).toBe(true)
  })

  it('does NOT grant allow-dyld-environment-variables (the pre-main dylib injection vector)', () => {
    expect(
      plist.includes('com.apple.security.cs.allow-dyld-environment-variables'),
      `allow-dyld-environment-variables is back in the production entitlements. ${HOWTO}`
    ).toBe(false)
  })

  /**
   * `disable-library-validation` is the OTHER half of the pair the report flagged.
   * It is deliberately STILL PRESENT for now: removing it can prevent the app from
   * loading its own native modules (node-pty, smart-whisper) unless every one is
   * signed with the same Team ID, which can only be confirmed by building and
   * launching a signed build on a real Mac. This assertion is intentionally NOT a
   * `.toBe(false)` — it documents the known-remaining state so a reviewer who
   * removes it later (after device verification) is prompted to update this test
   * instead of being surprised. Follow-up: drop the entitlement, then flip this to
   * assert its absence.
   */
  it('still grants disable-library-validation (pending on-device verification of native module signing)', () => {
    expect(plist.includes('com.apple.security.cs.disable-library-validation')).toBe(true)
  })
})
