import { describe, it, expect } from 'vitest'
import {
  parseOpencodePage,
  extractUsageBlock,
  topLevelNumber,
  normalizeCookieInput,
  filterAuthCookie,
  parseWorkspaceIds,
  isValidWorkspaceId,
  fetchOpencodeUsage
} from './opencode-usage'
import { primaryLimit } from '../../shared/usage-limits'

/**
 * A miniature of opencode.ai's React Flight wire data. NOTE: not captured from a live account —
 * no opencode session was available on the machine this was written on. It reproduces the
 * documented shape, including the two traps orca hit: a `$R[N]=` reference token between the
 * key and its object, and a null/decoy occurrence of the same key elsewhere on the page.
 */
const PAGE = `
  {billingContext:{monthlyUsage:null,plan:"pro"}}
  {rollingUsage:$R[28]={usagePercent:42,resetInSec:3600,label:"5h"}}
  {weeklyUsage:{usagePercent:77,resetInSec:172800}}
  {monthlyUsage:{usagePercent:15,resetInSec:1209600}}
`

describe('parseOpencodePage', () => {
  it('extracts the rolling, weekly and monthly windows', () => {
    const limits = parseOpencodePage(PAGE)
    expect(limits.map((l) => l.kind)).toEqual(['session', 'weekly_all', 'monthly_all'])
    expect(limits.map((l) => l.usedPercent)).toEqual([42, 77, 15])
  })

  it('reads through a React Flight $R[N]= reference token', () => {
    // The wire format puts a reference between the colon and the brace; a naive `key:{` match
    // would miss rollingUsage entirely.
    expect(parseOpencodePage(PAGE)[0].usedPercent).toBe(42)
  })

  it('skips a decoy occurrence that lacks usage fields', () => {
    // `monthlyUsage:null` appears first, inside billingContext. Matching the key alone would
    // return that and report no monthly window.
    expect(parseOpencodePage(PAGE).find((l) => l.kind === 'monthly_all')?.usedPercent).toBe(15)
  })

  it('turns resetInSec into an absolute timestamp', () => {
    // It is a DURATION from now, not a stamp. Using it raw would put every reset in 1970.
    const before = Date.now()
    const at = parseOpencodePage(PAGE)[0].resetsAt!
    expect(at).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(at).toBeLessThan(before + 3600 * 1000 + 5000)
  })

  it('pins the window durations rather than deriving them', () => {
    expect(parseOpencodePage(PAGE).map((l) => l.windowMinutes)).toEqual([300, 10_080, 43_200])
  })

  it('returns NOTHING when the format moves, rather than a partial guess', () => {
    // The whole risk of this provider: the page changes and the parser silently latches onto
    // something else. Both anchors missing must mean "no data", never a lone coincidental match.
    expect(parseOpencodePage('{someOtherShape:{value:5}}')).toEqual([])
    expect(parseOpencodePage('{monthlyUsage:{usagePercent:15,resetInSec:10}}')).toEqual([])
  })

  it('rejects an implausible reset instead of rendering it', () => {
    // A wrong number displayed confidently is worse than no number.
    const limits = parseOpencodePage(
      '{rollingUsage:{usagePercent:10,resetInSec:-5}}{weeklyUsage:{usagePercent:20,resetInSec:99999999}}'
    )
    expect(limits.map((l) => l.resetsAt)).toEqual([null, null])
  })

  it('clamps out-of-range percentages', () => {
    const limits = parseOpencodePage(
      '{rollingUsage:{usagePercent:180,resetInSec:60}}{weeklyUsage:{usagePercent:-4,resetInSec:60}}'
    )
    expect(limits.map((l) => l.usedPercent)).toEqual([100, 0])
  })

  it('refuses an absurdly large payload instead of brace-scanning it', () => {
    expect(parseOpencodePage('x'.repeat(10_000_001))).toEqual([])
    expect(parseOpencodePage('')).toEqual([])
  })

  it('leads with the most constrained window', () => {
    expect(primaryLimit(parseOpencodePage(PAGE))?.kind).toBe('weekly_all')
  })
})

describe('topLevelNumber', () => {
  it('ignores a same-named field nested deeper', () => {
    // Without depth tracking the first textual match wins and returns the wrong number.
    expect(topLevelNumber('{a:{usagePercent:99},usagePercent:5}', 'usagePercent')).toBe(5)
  })

  it('returns null when the field is absent', () => {
    expect(topLevelNumber('{other:1}', 'usagePercent')).toBeNull()
  })
})

describe('extractUsageBlock', () => {
  it('returns null when no occurrence carries both required fields', () => {
    expect(extractUsageBlock('{weeklyUsage:{usagePercent:5}}', 'weeklyUsage')).toBeNull()
  })
})

describe('cookie handling', () => {
  it('wraps a bare token so it does not fail confusingly', () => {
    expect(normalizeCookieInput('Fe26.2**abc')).toBe('auth=Fe26.2**abc')
  })

  it('leaves a real header alone, including a pasted "Cookie:" prefix', () => {
    expect(normalizeCookieInput('Cookie: auth=x; other=y')).toBe('auth=x; other=y')
  })

  it('sends ONLY auth cookies, never unrelated site cookies', () => {
    // Replaying a whole browser header would transmit unrelated sessions to opencode.
    expect(filterAuthCookie('analytics=1; auth=x; tracker=2')).toBe('auth=x')
    expect(filterAuthCookie('__Host-auth=y; ads=3')).toBe('__Host-auth=y')
  })

  it('returns null when nothing recognizable is present', () => {
    expect(filterAuthCookie('analytics=1; tracker=2')).toBeNull()
  })
})

describe('workspace ids', () => {
  it('extracts and de-duplicates ids', () => {
    expect(parseWorkspaceIds('id:"wrk_abc123", id:"wk_def", id:"wrk_abc123"')).toEqual([
      'wrk_abc123',
      'wk_def'
    ])
  })

  it('ignores ids that do not match the expected shape', () => {
    expect(parseWorkspaceIds('id:"user_123"')).toEqual([])
    expect(isValidWorkspaceId('wrk_abc')).toBe(true)
    expect(isValidWorkspaceId('nope')).toBe(false)
  })
})

describe('fetchOpencodeUsage', () => {
  it('reports unavailable with no cookie, without touching the network', async () => {
    await expect(fetchOpencodeUsage(null)).resolves.toMatchObject({
      provider: 'opencode',
      status: 'unavailable',
      limits: []
    })
  })

  it('reports unavailable when the paste carries no auth cookie', async () => {
    await expect(fetchOpencodeUsage('analytics=1; tracker=2')).resolves.toMatchObject({
      status: 'unavailable'
    })
  })

  it('reports ERROR, not unavailable, for a malformed workspace override', async () => {
    // The distinction this provider lives or dies by: configured-but-broken must never look
    // like not-configured, or a stale scraper quietly reads as "you have no usage".
    await expect(fetchOpencodeUsage('auth=x', 'not-a-workspace')).resolves.toMatchObject({
      status: 'error'
    })
  })
})
