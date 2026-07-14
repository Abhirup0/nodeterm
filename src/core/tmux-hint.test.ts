import { describe, it, expect } from 'vitest'
import { findCommand, tmuxInstallCommand } from './tmux-hint'

describe('tmuxInstallCommand', () => {
  it('darwin: brew when present, else no one-click command (text-only banner)', () => {
    expect(tmuxInstallCommand('darwin', (c) => c === 'brew')).toBe('brew install tmux')
    expect(tmuxInstallCommand('darwin', () => false)).toBeNull()
  })

  it('linux: picks the first known package manager, in order', () => {
    expect(tmuxInstallCommand('linux', (c) => c === 'apt-get')).toContain('apt-get install -y tmux')
    expect(tmuxInstallCommand('linux', (c) => c === 'dnf')).toBe('sudo dnf install -y tmux')
    expect(tmuxInstallCommand('linux', (c) => c === 'pacman')).toBe('sudo pacman -S --needed tmux')
    expect(tmuxInstallCommand('linux', (c) => c === 'apk')).toBe('sudo apk add tmux')
    // apt-get outranks dnf when both exist (Debian-family first, matching the server docs' target).
    expect(tmuxInstallCommand('linux', () => true)).toContain('apt-get')
    expect(tmuxInstallCommand('linux', () => false)).toBeNull()
  })

  it('win32 (no native tmux): never suggests a command', () => {
    expect(tmuxInstallCommand('win32', () => true)).toBeNull()
  })
})

describe('findCommand', () => {
  it('scans PATH entries and the common GUI-blind dirs (apps do not inherit the shell PATH)', () => {
    const seen: string[] = []
    const exists = (p: string) => (seen.push(p), p === '/opt/homebrew/bin/brew')
    expect(findCommand('brew', { PATH: '/usr/bin:/bin' }, exists)).toBe(true)
    expect(seen).toContain('/usr/bin/brew') // PATH first
    expect(seen).toContain('/opt/homebrew/bin/brew') // then the common dirs
    expect(findCommand('brew', { PATH: '/usr/bin' }, () => false)).toBe(false)
  })

  it('tolerates a missing PATH', () => {
    expect(findCommand('brew', {}, (p) => p === '/usr/local/bin/brew')).toBe(true)
  })
})
