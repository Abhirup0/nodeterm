export type SettingsSectionId =
  | 'terminal'
  | 'shell'
  | 'behavior'
  | 'appearance'
  | 'agents'
  | 'custom-agents'
  | 'notifications'
  | 'commit'
  | 'tmux'
  | 'license'
  | 'remote'
  | 'ssh'
  | 'updates'
  | 'privacy'

export interface SettingsGroup {
  id: string
  title: string
  sections: { id: SettingsSectionId; title: string }[]
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'general',
    title: 'General',
    sections: [
      { id: 'terminal', title: 'Terminal' },
      { id: 'shell', title: 'Shell' },
      { id: 'behavior', title: 'Behavior' },
      { id: 'appearance', title: 'Appearance' }
    ]
  },
  {
    id: 'agents',
    title: 'Agents',
    sections: [
      { id: 'agents', title: 'Agents' },
      { id: 'custom-agents', title: 'Custom agents' },
      { id: 'notifications', title: 'Notifications' },
      { id: 'commit', title: 'Commit messages' }
    ]
  },
  {
    id: 'sessions',
    title: 'Sessions',
    sections: [{ id: 'tmux', title: 'tmux' }]
  },
  {
    id: 'account',
    title: 'Account',
    sections: [
      { id: 'license', title: 'License' },
      { id: 'remote', title: 'Remote access' },
      { id: 'ssh', title: 'Remote (SSH)' }
    ]
  },
  {
    id: 'application',
    title: 'Application',
    sections: [
      { id: 'updates', title: 'Updates' },
      { id: 'privacy', title: 'Privacy' }
    ]
  }
]

export const FIRST_SECTION_ID: SettingsSectionId = 'terminal'

export function allSectionIds(): SettingsSectionId[] {
  return SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.id))
}
