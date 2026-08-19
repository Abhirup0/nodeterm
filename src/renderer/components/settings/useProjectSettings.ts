import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  resolveProjectSettings,
  type ProjectLocalSettings,
  type ProjectSettingsDoc,
  type ProjectSettingsFileV1,
  type ProjectSettingsSnapshot,
  type ResolvedProjectSettings
} from '@shared/project-settings'

/**
 * One project's `.nodeterm/settings.json` (the git-shared doc) plus this machine's local overlay,
 * as the Settings panel needs them: the raw snapshot for provenance/conflict decisions, the
 * resolved local-over-shared view for showing effective values, and two savers.
 *
 * `snapshot` is `'loading'` until the first read answers, then the snapshot, or `null` when the
 * project is unknown to the store or the read failed. A failed read is never an exception here:
 * the panel must still render its identity rows for a project whose settings file is unreadable.
 */
export interface ProjectSettingsHook {
  snapshot: ProjectSettingsSnapshot | null | 'loading'
  /** `resolveProjectSettings(local, shared)`; empty families while the first read is in flight. */
  resolved: ResolvedProjectSettings
  /**
   * Commits an edit to the GIT-SHARED document. The argument is a PATCH, merged field-by-field
   * into the document that was last read — `writeShared` is a whole-document write (it replaces
   * the file), so an editor that owns one field must not blank its siblings. A field set to
   * `undefined` is removed; a family left with no fields is removed with it, so an unset setting
   * adds no bytes to a file the whole team reads.
   *
   * Returns the store's accept/refuse answer, and re-reads on success: the store bumped `rev` and
   * may have sanitized what it wrote, so what the panel shows afterwards is the FILE, not our hope.
   */
  saveShared(doc: ProjectSettingsDoc): Promise<boolean>
  /** This machine's overlay, written whole (`undefined` clears it). Re-reads on success. */
  saveLocal(local: ProjectLocalSettings | undefined): Promise<boolean>
  reload(): void
}

/** The document half of a shared file — `version`/`rev`/`savedAt` belong to the store, which
 *  re-stamps them on every write, so they never travel back through an editor. */
function docOf(shared: ProjectSettingsFileV1 | null | undefined): ProjectSettingsDoc {
  if (!shared) return {}
  const { version: _version, rev: _rev, savedAt: _savedAt, ...doc } = shared
  return doc
}

/**
 * Field-level merge of `patch` into `current`, dropping `undefined` (a cleared field) and any
 * family the clearing leaves empty. Exported for the tests that pin the "an editor never blanks a
 * field it does not own" rule.
 */
export function mergeSharedDoc(
  current: ProjectSettingsDoc,
  patch: ProjectSettingsDoc
): ProjectSettingsDoc {
  const out: Record<string, unknown> = { ...current }
  for (const family of Object.keys(patch) as (keyof ProjectSettingsDoc)[]) {
    const patchFamily = patch[family] as Record<string, unknown> | undefined
    if (patchFamily === undefined) {
      delete out[family]
      continue
    }
    const merged: Record<string, unknown> = {
      ...(current[family] as Record<string, unknown> | undefined),
      ...patchFamily
    }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
    if (Object.keys(merged).length === 0) delete out[family]
    else out[family] = merged
  }
  return out as ProjectSettingsDoc
}

const EMPTY_FAMILIES = (): ResolvedProjectSettings => resolveProjectSettings(undefined, undefined)

export function useProjectSettings(projectId: string): ProjectSettingsHook {
  const [snapshot, setSnapshot] = useState<ProjectSettingsSnapshot | null | 'loading'>('loading')
  const [nonce, setNonce] = useState(0)

  // The merge base for `saveShared` must be the LATEST snapshot, without making the saver identity
  // change on every read (a blur handler holding last render's saver would then merge into a stale
  // document and silently revert a sibling field).
  const snapshotRef = useRef<ProjectSettingsSnapshot | null | 'loading'>(snapshot)
  snapshotRef.current = snapshot

  useEffect(() => {
    let alive = true
    setSnapshot('loading')
    void window.nodeTerminal.projectSettings.read(projectId).then(
      (s) => {
        if (alive) setSnapshot(s)
      },
      () => {
        if (alive) setSnapshot(null)
      }
    )
    return () => {
      alive = false
    }
  }, [projectId, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const saveShared = useCallback(
    async (doc: ProjectSettingsDoc): Promise<boolean> => {
      const snap = snapshotRef.current
      const current = snap && snap !== 'loading' ? docOf(snap.shared) : {}
      const ok = await window.nodeTerminal.projectSettings.writeShared(
        projectId,
        mergeSharedDoc(current, doc)
      )
      if (ok) reload()
      return ok
    },
    [projectId, reload]
  )

  const saveLocal = useCallback(
    async (local: ProjectLocalSettings | undefined): Promise<boolean> => {
      const ok = await window.nodeTerminal.projectSettings.updateLocal(projectId, local)
      if (ok) reload()
      return ok
    },
    [projectId, reload]
  )

  const resolved = useMemo(
    () =>
      snapshot && snapshot !== 'loading'
        ? resolveProjectSettings(snapshot.local, docOf(snapshot.shared))
        : EMPTY_FAMILIES(),
    [snapshot]
  )

  return { snapshot, resolved, saveShared, saveLocal, reload }
}
