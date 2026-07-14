import { describe, it, expect } from 'vitest'
import { findCommand, tmuxInstall } from './tmux-hint'

describe('tmuxInstall', () => {
  it('darwin with brew: one-click brew install', () => {
    expect(tmuxInstall('darwin', (c) => c === 'brew')).toEqual({
      command: 'brew install tmux',
      label: 'Install tmux'
    })
  })

  it('darwin WITHOUT brew: bootstraps Homebrew first (official installer), then tmux — never text-only', () => {
    const hint = tmuxInstall('darwin', () => false)
    expect(hint?.label).toBe('Install Homebrew + tmux')
    expect(hint?.command).toContain('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')
    // The fresh brew is not on this shell's PATH — the chain must call it by absolute path
    // (Apple Silicon first, Intel fallback) or the second step dies right after the first.
    expect(hint?.command).toContain('/opt/homebrew/bin/brew')
    expect(hint?.command).toContain('/usr/local/bin/brew')
    expect(hint?.command).toContain('install tmux')
  })

  it('linux: picks the first known package manager, in order', () => {
    expect(tmuxInstall('linux', (c) => c === 'apt-get')?.command).toContain('apt-get install -y tmux')
    expect(tmuxInstall('linux', (c) => c === 'dnf')?.command).toBe('sudo dnf install -y tmux')
    expect(tmuxInstall('linux', (c) => c === 'pacman')?.command).toBe('sudo pacman -S --needed tmux')
    expect(tmuxInstall('linux', (c) => c === 'apk')?.command).toBe('sudo apk add tmux')
    // apt-get outranks dnf when both exist (Debian-family first, matching the server docs' target).
    expect(tmuxInstall('linux', () => true)?.command).toContain('apt-get')
    expect(tmuxInstall('linux', () => true)?.label).toBe('Install tmux')
    expect(tmuxInstall('linux', () => false)).toBeNull()
  })

  it('win32 (no native tmux): never suggests a command', () => {
    expect(tmuxInstall('win32', () => true)).toBeNull()
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
