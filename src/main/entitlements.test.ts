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
 * WHY REMOVING THE DYLD ENTITLEMENT IS SAFE, measured twice:
 *  1. Nothing in this repo reads `DYLD_*`. The only references are in
 *     `src/core/claude-accounts-core.ts` (and its tests), which STRIP `DYLD_*`
 *     OUT of spawned child agent processes — the opposite direction.
 *  2. It is not an Electron requirement. electron-builder's own default template
 *     (`node_modules/app-builder-lib/templates/entitlements.mac.plist`) grants
 *     exactly `allow-jit`, `allow-unsigned-executable-memory` and
 *     `disable-library-validation` — `allow-dyld-environment-variables` is NOT in
 *     it. It was an addition on top of the default, so removing it returns us to
 *     the stock Electron packaging posture rather than departing from it.
 *
 * The same measurement is why `disable-library-validation` STAYS: it IS in
 * electron-builder's default set (their template cites electron-builder#3940),
 * because Electron apps need it to load native modules such as node-pty and
 * smart-whisper. Dropping it can only be validated by launching a SIGNED build on
 * a real Mac, and the reporter's own controls showed it does not enable the
 * attack on its own.
 *
 * SHAPE OF THE GUARD: an ALLOWLIST, not a snapshot. It fails when an entitlement
 * nobody reviewed is ADDED, and stays green when one is removed — so tightening
 * the entitlements later (e.g. dropping `disable-library-validation` after device
 * verification) never has to fight this test. It reads the plist rather than a
 * signed binary, so it runs on the ubuntu CI runner via `npm test` on every
 * PR/push — the release-CI assertion the report asked for.
 */
const ENTITLEMENTS = path.resolve(__dirname, '../../build/entitlements.mac.plist')

/**
 * Every entitlement the production build is allowed to request, each with the
 * reason it survived review. electron-builder's default three, plus the
 * microphone (the dictation feature; paired with NSMicrophoneUsageDescription in
 * the package.json `build.mac.extendInfo`).
 */
const REVIEWED_ENTITLEMENTS: Readonly<Record<string, string>> = {
  'com.apple.security.cs.allow-jit': "electron-builder default — V8's JIT",
  'com.apple.security.cs.allow-unsigned-executable-memory': 'electron-builder default',
  'com.apple.security.cs.disable-library-validation':
    'electron-builder default (electron-builder#3940) — loads node-pty / smart-whisper',
  'com.apple.security.device.audio-input': 'dictation (speech-to-text) captures the microphone'
}

/**
 * Entitlements that must never come back, with what they cost. Kept separate from
 * the allowlist so the failure message names the vulnerability rather than just
 * saying "unreviewed key".
 */
const FORBIDDEN_ENTITLEMENTS: Readonly<Record<string, string>> = {
  'com.apple.security.cs.allow-dyld-environment-variables':
    'permits DYLD_INSERT_LIBRARIES pre-main dylib injection into the signed, notarized ' +
    'process, which then holds nodeterm code identity against Keychain-backed safeStorage ' +
    '(Fortress MSSP report, 2026-08-23). Nothing in this app reads DYLD_*, and it is not ' +
    "in electron-builder's default template."
}

/** Keys requested by the plist, in file order. */
function entitlementKeys(plist: string): string[] {
  return [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1].trim())
}

describe('macOS production entitlements', () => {
  const exists = fs.existsSync(ENTITLEMENTS)
  const plist = exists ? fs.readFileSync(ENTITLEMENTS, 'utf8') : ''
  const keys = entitlementKeys(plist)

  it('build/entitlements.mac.plist exists and requests something', () => {
    expect(exists, `Missing ${ENTITLEMENTS}`).toBe(true)
    expect(keys.length).toBeGreaterThan(0)
  })

  it('requests no entitlement that permits pre-main code injection', () => {
    for (const [key, why] of Object.entries(FORBIDDEN_ENTITLEMENTS)) {
      expect(keys, `${key} is back in the production entitlements: ${why}`).not.toContain(key)
    }
  })

  it('requests only reviewed entitlements', () => {
    const unreviewed = keys.filter((k) => !(k in REVIEWED_ENTITLEMENTS))
    expect(
      unreviewed,
      'Unreviewed macOS entitlement(s) in the production build. A hardened-runtime exception ' +
        'weakens the signed process — add it to REVIEWED_ENTITLEMENTS with the reason only ' +
        'after deciding it is genuinely required, and check it is not one Electron already ' +
        'works without.'
    ).toEqual([])
  })
})
