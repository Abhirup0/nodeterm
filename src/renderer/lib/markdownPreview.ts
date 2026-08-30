// Whether an editor node should OPEN in the rendered markdown preview
// (`settings.openMarkdownPreview`). Deliberately narrower than the Preview/Edit toggle,
// which works on any text file: auto-preview is only for files that are actually markdown —
// opening, say, a .ts file as a markdown render would be a confusing default for a setting
// named after markdown.

/** Extensions treated as markdown for the auto-preview decision (lowercase, no dot). */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownExt(ext: string): boolean {
  return MARKDOWN_EXTS.has(ext.toLowerCase())
}

/** True when a freshly opened editor node should start in preview instead of the editor. */
export function opensInPreview(ext: string, openMarkdownPreview: boolean): boolean {
  return openMarkdownPreview && isMarkdownExt(ext)
}
