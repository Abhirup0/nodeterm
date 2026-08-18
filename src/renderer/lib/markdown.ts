import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Render markdown text to sanitized HTML (safe for dangerouslySetInnerHTML).
 *  `breaks` keeps single newlines as <br> — for sticky notes, where the text predates markdown
 *  rendering and a plain list of lines must not collapse into one paragraph. */
export function renderMarkdown(src: string, opts?: { breaks?: boolean }): string {
  const html = marked.parse(src || '', { async: false, breaks: opts?.breaks ?? false }) as string
  return DOMPurify.sanitize(html)
}
