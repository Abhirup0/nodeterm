import { promises as fs } from 'fs'
import path from 'path'
import {
  parseProjectSettingsFile,
  sameProjectSettingsContent,
  serializeProjectSettingsFile,
  PROJECT_SETTINGS_FILE,
  type ProjectSettingsDoc,
  type ProjectSettingsFileV1
} from '../shared/project-settings'
import { PROJECT_DIR } from './workspace-files'
import { writeAtomic } from './workspace-store'

/**
 * Local disk IO for <cwd>/.nodeterm/settings.json — the sibling of workspace-store's project.json
 * handling, same trust boundary (the file is git-shared hostile input; see shared/project-settings.ts).
 */
export type ProjectSettingsRead =
  | { status: 'ok'; file: ProjectSettingsFileV1 }
  | { status: 'absent' }
  | { status: 'conflict' } // left in place, user must resolve
  | { status: 'invalid' } // sidelined to .corrupt-<ts> (only copy protected)
  | { status: 'error' } // fs error other than ENOENT

export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, PROJECT_DIR, PROJECT_SETTINGS_FILE)
}

export async function readProjectSettingsFile(cwd: string): Promise<ProjectSettingsRead> {
  const file = projectSettingsPath(cwd)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' } : { status: 'error' }
  }
  const parsed = parseProjectSettingsFile(raw)
  if (parsed.status === 'ok') return parsed
  if (parsed.status === 'conflict') return { status: 'conflict' } // left in place — user must resolve
  // invalid: sideline the only copy so a later write can't overwrite unrecoverable content.
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`)
  } catch { /* best effort — never destroy data */ }
  return { status: 'invalid' }
}

/** Whole-document write. Bumps rev over `prev`; skips the write (returns prev) when content is
 *  unchanged. Creates .nodeterm/ if missing. */
export async function writeProjectSettingsFile(
  cwd: string,
  doc: ProjectSettingsDoc,
  prev: ProjectSettingsFileV1 | null,
  savedAt: string
): Promise<ProjectSettingsFileV1> {
  // `doc` spreads FIRST: a caller may pass back a previously-read ProjectSettingsFileV1 (it
  // structurally satisfies ProjectSettingsDoc), and its stale version/rev/savedAt must never win
  // over the bookkeeping this function computes — that would silently defeat rev monotonicity.
  const candidate: ProjectSettingsFileV1 = { ...doc, version: 1, rev: (prev?.rev ?? 0) + 1, savedAt }
  if (prev && sameProjectSettingsContent(prev, candidate)) return prev
  const file = projectSettingsPath(cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeAtomic(file, serializeProjectSettingsFile(candidate))
  return candidate
}
