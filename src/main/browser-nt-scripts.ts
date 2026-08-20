/**
 * The page-side script table.
 *
 * Arbitrary page-side script running is excluded from the CDP allowlist (browser-cdp-allowlist.ts),
 * so all page-side logic runs through CDP's call-a-function-on-object method against THIS table, and
 * agent input reaches a script only as an argument value, never as source. That moves the risk from
 * "arbitrary JS in the page's origin" to "a bug in OUR scripts" — a much smaller surface, but not
 * zero: a stray template literal or a dynamic-code sink in one of these is a complete escape.
 *
 * Three things hold the line and each is a requirement:
 *   1. every entry is a plain single-quoted string literal with NO interpolation and NO
 *      concatenation — the selector is passed in, never spliced into source;
 *   2. a source-level test (browser-nt-scripts.source.test.ts) fails the build if this file gains a
 *      backtick, a dollar-brace interpolation, a dynamic-code token, an HTML-writing sink or a
 *      token-store reference, if the table stops being frozen, or if isNtScript stops being identity
 *      membership;
 *   3. every script is a PURE READER — it clicks nothing, navigates nothing, submits nothing and
 *      assigns nothing. Every EFFECT goes through Input.* / Page.* instead, which is also what makes
 *      an effect traceable.
 *
 * The table holds only what PRs 7-8 need. Each reader takes its inputs as ordinary parameters,
 * supplied as argument VALUES by the CDP call — the string in arguments[].value, checked scalar in
 * the allowlist, is the only agent-controlled data that ever reaches these functions.
 */
export const NT_SCRIPTS = Object.freeze({
  /** The document title. */
  readTitle: 'function(){ return document.title }',

  /** A map of interactable elements: a ref index, role, accessible NAME (never a field's value), id,
   *  input type, whether a field is FILLED (a boolean — never the value), a link's absolute href, and
   *  the element centre in viewport coordinates (what a later Input.dispatchMouseEvent aims at).
   *  Read-only. Off-screen (zero-box), display:none and aria-hidden elements are skipped by
   *  construction, which is what keeps a hidden CSRF input and an aria-hidden block out of the map. */
  readMap:
    'function(){ var els = document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[onclick]"); var out = []; for (var i = 0; i < els.length; i++) { var el = els[i]; var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) continue; if (el.closest && el.closest("[aria-hidden=true]")) continue; var tag = el.tagName.toLowerCase(); var role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : tag); var isField = tag === "input" || tag === "textarea" || tag === "select"; var name = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 80); out.push({ ref: i, tag: tag, role: role, id: el.id || "", type: el.getAttribute("type"), name: name, href: tag === "a" ? el.href : null, filled: isField ? (el.value ? true : false) : null, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }); } return out }',

  /** Every visible link as { href, text }. Read-only. */
  readLinks:
    'function(){ var as = document.querySelectorAll("a[href]"); var out = []; for (var i = 0; i < as.length; i++) { out.push({ href: as[i].href, text: (as[i].innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) }); } return out }',

  /** The visible text of a selector (or the whole body when none is given), plus the untruncated
   *  length so main can announce an in-band truncation. Capped at the hard ceiling (60000) so a huge
   *  page never ships megabytes over CDP; main applies the caller's --max (<= ceiling) to the text.
   *  innerText semantics exclude <script>, <style> and display:none BY CONSTRUCTION (they are the
   *  RENDERED text). They do NOT drop aria-hidden content — that lives in the accessibility tree, not
   *  in innerText — so this reader makes no aria-hidden promise; its real property is that no hidden
   *  input value and no <script> body ride along. Read-only. */
  readText:
    'function(sel){ var el = sel ? document.querySelector(sel) : document.body; if (!el) return null; var t = el.innerText || ""; return { text: t.slice(0, 60000), total: t.length } }',

  /** Re-locate a ref from readMap and return its current centre and tag, or null if it is gone. The
   *  ref is re-resolved against the SAME enumeration; generation staleness is enforced in main. */
  resolveRef:
    'function(i){ var els = document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[onclick]"); var el = els[i]; if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, w: r.width, h: r.height } }',

  /** Resolve a CSS selector to its current centre and tag, or null. Read-only. */
  resolveSelector:
    'function(s){ var el = document.querySelector(s); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, w: r.width, h: r.height } }',

  /** Describe a selector's element without exposing its markup: tag, id, role, label, short text. */
  describeElement:
    'function(s){ var el = document.querySelector(s); if (!el) return null; return { tag: el.tagName, id: el.id, role: el.getAttribute("role"), label: el.getAttribute("aria-label"), disabled: !!el.disabled, text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) } }',

  /** Is a selector's element on-screen and displayed? Read-only. */
  isVisible:
    'function(s){ var el = document.querySelector(s); if (!el) return false; var r = el.getBoundingClientRect(); var st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" }',

  /** A readiness probe: is the document loaded, and (optionally) is a selector present yet? */
  waitProbe:
    'function(s){ if (document.readyState !== "complete") return false; if (!s) return true; return document.querySelector(s) != null }',

  /** The currently-focused EDITABLE field, or null — used by --type with no --into to tell "type into
   *  the focused field" from "nothing is focused" (Task 8.2). Returns only the tag + id, never a
   *  value: reading document.activeElement is a read, and a text/select/contenteditable focus is the
   *  only thing that makes a bare --type well-defined. Read-only. */
  activeField:
    'function(){ var el = document.activeElement; if (!el || el === document.body) return null; var tag = el.tagName ? el.tagName.toLowerCase() : ""; var editable = tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true; if (!editable) return null; return { tag: tag, id: el.id || "" } }'
})

export type NtScriptName = keyof typeof NT_SCRIPTS

const NT_SCRIPT_VALUES: ReadonlySet<string> = new Set(Object.values(NT_SCRIPTS))

/**
 * IDENTITY membership: is fn byte-for-byte one of the table's entries? Never a shape check, never
 * a prefix match — a value that merely LOOKS like a reader is refused. This is what the allowlist's
 * call-a-function check leans on, so a trailing space or an added statement makes it a stranger.
 */
export function isNtScript(fn: string): boolean {
  return NT_SCRIPT_VALUES.has(fn)
}
