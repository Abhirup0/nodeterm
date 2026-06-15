import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Render markdown text to sanitized HTML (safe for dangerouslySetInnerHTML). */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src || '', { async: false }) as string
  return DOMPurify.sanitize(html)
}
