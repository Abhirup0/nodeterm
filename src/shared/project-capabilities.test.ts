import { describe, it, expect } from 'vitest'
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_COPY,
  projectCapabilityFlagInFile,
  readProjectCapabilities,
  projectCapabilityFields
} from './project-capabilities'

describe('projectCapabilityFlagInFile is STRICT (and NEVER a grant check — see project-capability-consent)', () => {
  it('true enables', () => {
    expect(projectCapabilityFlagInFile({ agentBrowserControl: true }, 'agentBrowserControl')).toBe(true)
  })
  it.each([undefined, false, null, 0, 1, 'true', 'yes', {}, [], 'false'])(
    'everything else is OFF (%j) — project.json is hostile input, not a truthiness exercise',
    (v) => {
      expect(projectCapabilityFlagInFile({ agentBrowserControl: v } as never, 'agentBrowserControl')).toBe(false)
    }
  )
  it('an absent project is off, never a throw', () => {
    expect(projectCapabilityFlagInFile(undefined, 'agentBrowserControl')).toBe(false)
    expect(projectCapabilityFlagInFile(null, 'agentBrowserControl')).toBe(false)
  })
  it('a prototype-inherited true is OFF — own properties only (M-1)', () => {
    const inherited = Object.create({ agentBrowserControl: true }) as Record<string, unknown>
    expect(projectCapabilityFlagInFile(inherited, 'agentBrowserControl')).toBe(false)
    expect(readProjectCapabilities(inherited)).toEqual({})
  })
})

describe('readProjectCapabilities normalises whatever the file carried', () => {
  it('keeps only literal true, and only known keys', () => {
    expect(readProjectCapabilities({ agentBrowserControl: 'true', nope: true })).toEqual({})
    expect(readProjectCapabilities({ agentBrowserControl: true })).toEqual({ agentBrowserControl: true })
    expect(readProjectCapabilities({ agentBrowserControl: true, nope: true })).toEqual({
      agentBrowserControl: true
    })
  })
  it('survives a non-object file', () => {
    expect(readProjectCapabilities(null)).toEqual({})
    expect(readProjectCapabilities('x')).toEqual({})
    expect(readProjectCapabilities(undefined)).toEqual({})
  })
})

describe('projectCapabilityFields — the spread projectToFile uses', () => {
  it('omits an off capability entirely (no bytes, no git churn) and survives null', () => {
    expect(projectCapabilityFields({ agentBrowserControl: false })).toEqual({})
    expect(projectCapabilityFields(null)).toEqual({})
    expect(projectCapabilityFields({ agentBrowserControl: true })).toEqual({ agentBrowserControl: true })
  })
})

describe('agentMessaging is a registry capability (messaging PR 6) — a line in the registry, zero new mechanism', () => {
  it('is in PROJECT_CAPABILITIES, so every generated surface (round-trip, notice, Settings row) covers it', () => {
    expect(PROJECT_CAPABILITIES).toContain('agentMessaging')
  })
  it('reads with the same strictness as every capability — project.json stays hostile input', () => {
    expect(projectCapabilityFlagInFile({ agentMessaging: true }, 'agentMessaging')).toBe(true)
    expect(projectCapabilityFlagInFile({ agentMessaging: 'true' } as never, 'agentMessaging')).toBe(false)
    expect(readProjectCapabilities({ agentMessaging: 1 })).toEqual({})
    expect(projectCapabilityFields({ agentMessaging: true })).toEqual({ agentMessaging: true })
  })
})

describe('every capability has copy, and the copy says what travels', () => {
  it.each(PROJECT_CAPABILITIES)('%s has label, description and cloneWarning', (cap) => {
    const c = PROJECT_CAPABILITY_COPY[cap]
    expect(c.label.length).toBeGreaterThan(0)
    expect(c.description.length).toBeGreaterThan(0)
    // The same wording class as TabBar's bypassPermissions title: the two git-shared grants read alike.
    expect(c.cloneWarning).toContain('.nodeterm/project.json')
  })
})
