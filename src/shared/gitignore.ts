/**
 * Pure .gitignore line edits for the "Add to / Remove from .gitignore" context-menu actions
 * (Source Control file rows + Explorer entries). Deliberately line-based, not pattern-aware:
 * ADD writes one anchored line, and REMOVE only offers itself when one of these exact lines is
 * present — an entry ignored by a broader pattern (`*.log`, `dist/`) gets no remove action,
 * because deleting or rewriting a user's pattern on their behalf is not a menu click's call.
 */

/** Normalize a repo-root-relative path for matching: no leading/trailing slashes. */
const norm = (relPath: string): string => relPath.replace(/^\/+/, '').replace(/\/+$/, '')

/** The exact .gitignore lines that mean `relPath` and nothing broader (± anchor, ± dir slash). */
const lineVariants = (relPath: string): Set<string> => {
  const p = norm(relPath)
  return new Set([p, `/${p}`, `${p}/`, `/${p}/`])
}

/** Is `relPath` itself (not a broader pattern) an exact line of this .gitignore? */
export function gitignoreHasExact(content: string, relPath: string): boolean {
  if (!norm(relPath)) return false
  const v = lineVariants(relPath)
  return content.split(/\r?\n/).some((l) => v.has(l.trim()))
}

/**
 * Append an ignore line for `relPath` (no-op when an exact line already exists). The line is
 * ANCHORED (`/dist`, not `dist`): a bare name is a pattern that matches in every subdirectory,
 * which is more than "ignore this entry" promised.
 */
export function gitignoreAdd(content: string, relPath: string): string {
  const p = norm(relPath)
  if (!p || gitignoreHasExact(content, relPath)) return content
  const line = `/${p}`
  if (!content.trim()) return `${line}\n`
  return `${content.replace(/\n+$/, '')}\n${line}\n`
}

/** Remove every exact line meaning `relPath`; comments, patterns and other lines are untouched. */
export function gitignoreRemove(content: string, relPath: string): string {
  if (!norm(relPath)) return content
  const v = lineVariants(relPath)
  const kept = content.split(/\r?\n/).filter((l) => !v.has(l.trim()))
  const out = kept.join('\n').replace(/\n+$/, '')
  return out ? `${out}\n` : ''
}
