import { promises as fs } from 'fs'
import path from 'path'
import { renameAtomic } from './fs-atomic'
import {
  parseProjectSettingsFile,
  sameProjectSettingsContent,
  sanitizeProjectSettingsDoc,
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
    await renameAtomic(file, `${file}.corrupt-${Date.now()}`)
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
  // CANONICAL SHAPE — bookkeeping first, then the sanitized doc, i.e. exactly what
  // `parseProjectSettingsFile` builds. Two properties ride on that:
  //  - `sameProjectSettingsContent` compares JSON.stringify output, which is key-ORDER sensitive.
  //    `prev` almost always comes from a parse (every save reads first), so a doc-first candidate
  //    would compare unequal to identical content and bump rev + rewrite a git-tracked file on
  //    every no-op save.
  //  - sanitizing here (not only at the callers) means a passed-back ProjectSettingsFileV1 — which
  //    structurally satisfies ProjectSettingsDoc — loses its stale version/rev/savedAt instead of
  //    overwriting the bookkeeping below, and no unsanitized byte ever reaches the user's repo.
  const candidate: ProjectSettingsFileV1 = {
    version: 1,
    rev: (prev?.rev ?? 0) + 1,
    savedAt,
    ...sanitizeProjectSettingsDoc(doc)
  }
  if (prev && sameProjectSettingsContent(prev, candidate)) return prev
  const file = projectSettingsPath(cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeAtomic(file, serializeProjectSettingsFile(candidate))
  return candidate
}
