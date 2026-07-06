import { describe, it, expect } from 'vitest'
import { machOArch, archMismatch } from './macho-arch'

// On-disk little-endian Mach-O 64 header: magic cf fa ed fe, then cputype (LE int32).
function header(cpuTypeLE: number[]): Buffer {
  return Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...cpuTypeLE])
}

describe('machOArch', () => {
  it('identifies arm64 (cputype 0x0100000c)', () => {
    expect(machOArch(header([0x0c, 0x00, 0x00, 0x01]))).toBe('arm64')
  })
  it('identifies x86_64 (cputype 0x01000007)', () => {
    expect(machOArch(header([0x07, 0x00, 0x00, 0x01]))).toBe('x86_64')
  })
  it('identifies a fat/universal binary (cafebabe big-endian)', () => {
    expect(machOArch(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]))).toBe('universal')
  })
  it('returns unknown for short or non-Mach-O input', () => {
    expect(machOArch(Buffer.from([1, 2, 3]))).toBe('unknown')
    expect(machOArch(Buffer.from('#!/bin/sh\n'))).toBe('unknown')
  })
})

describe('archMismatch', () => {
  it('flags an x86_64 helper in an arm64 process (the release-clobber incident)', () => {
    expect(archMismatch('x86_64', 'arm64')).toBe(true)
  })
  it('flags an arm64 helper in an x64 process', () => {
    expect(archMismatch('arm64', 'x64')).toBe(true)
  })
  it('accepts matching arch and never flags universal/unknown', () => {
    expect(archMismatch('arm64', 'arm64')).toBe(false)
    expect(archMismatch('x86_64', 'x64')).toBe(false)
    expect(archMismatch('universal', 'arm64')).toBe(false)
    expect(archMismatch('unknown', 'arm64')).toBe(false)
  })
})
