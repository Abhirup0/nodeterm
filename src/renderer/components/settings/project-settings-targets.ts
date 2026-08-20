import type { SettingsSectionId } from './nav'

const PROJECT_SECTION_PREFIX = 'project-'

/** Builds the dynamic settings section id for a project. */
export function projectSectionId(projectId: string): SettingsSectionId {
  return `${PROJECT_SECTION_PREFIX}${projectId}` as SettingsSectionId
}

/** Inverse of {@link projectSectionId}. Returns null for non-project ids and for an empty project id. */
export function parseProjectSectionId(id: string): string | null {
  if (!id.startsWith(PROJECT_SECTION_PREFIX)) return null
  const projectId = id.slice(PROJECT_SECTION_PREFIX.length)
  return projectId === '' ? null : projectId
}
