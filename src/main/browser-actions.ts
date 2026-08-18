/**
 * The CDP execution for the `browser` verb's PR-7 actions — `--nav` and the `--read` family. Every
 * command here goes through the injected `send` (a {@link import('./browser-lease').BrowserSession}'s
 * `send`, which routes through `sendCdp` → the allowlist), so this module cannot reach a CDP method
 * the gate refuses. Main-side only (it reads a real page); never Server Edition.
 *
 * THE EVENT BOUNDARY (design §3.2, Task 7.3). We subscribe to a FIXED set of CDP events —
 * Page.frameNavigated, Page.loadEventFired, Network.responseReceived (main frame),
 * Runtime.executionContextsCleared — and NOTHING is streamed to the agent. S8 forwarded every CDP
 * event to its client as a firehose; here events feed our own state (the {@link CdpEventBus}) only,
 * and the agent sees verb REPLIES. `browser-actions.test.ts` asserts there is no passive channel out
 * of the page: extra events emitted during a nav never appear in the reply.
 *
 * THE READ BOUNDARY (design §3.1, Task 7.4). Page-side logic runs ONLY as a frozen NT_SCRIPTS entry,
 * by identity, through Runtime.callFunctionOn with returnByValue — NO agent-derived character ever
 * reaches an `expression` field, because this module never issues Runtime.evaluate at all. A test
 * spies on every send and fails on any `expression` key.
 *
 * CDP child-session bookkeeping and the wheel/scroll salvage come from PR #112's S8 (@Corvin,
 * proteus-dev); the nav/read shape here is new.
 */
import { NT_SCRIPTS } from './browser-nt-scripts'
import type { RefTable } from './browser-refs'
import type { BrowserReadMode } from '../core/browser-verb'

/** A one-line agent-facing outcome. `ok:false` is a NAMED refusal, never a hang and never a raw
 *  Electron error. */
export interface ActionResult {
  ok: boolean
  message: string
}

/** The one capability the actions need from a lease: send a (gated) CDP command. */
export interface Sendable {
  send(method: string, params: object): Promise<unknown>
}

/** The `--read text` hard ceiling and default; the parser clamps `--max` to the ceiling too. */
export const READ_TEXT_DEFAULT_MAX = 20_000
export const READ_TEXT_CEILING = 60_000
const LIST_CAP = 200
const LIST_BYTES = 8192

type CdpEvent = { method: string; params: Record<string, unknown> }

/**
 * The fixed-set event sink for one guest. Fed by `debugger.on('message')` in index.ts; read by
 * {@link browserNav}. It records only the main-frame document status and drives ref invalidation on
 * a navigation — it has NO path that hands an event to an agent-facing channel.
 */
export class CdpEventBus {
  private readonly waiters = new Set<{ match: (e: CdpEvent) => boolean; resolve: (e: CdpEvent | null) => void }>()
  private mainFrameStatus: number | undefined

  /** `onNavigation` bumps the node's ref generation (Task 5.5) — the single invalidation path both
   *  Page.frameNavigated and Runtime.executionContextsCleared funnel through. */
  constructor(private readonly onNavigation?: () => void) {}

  emit(method: string, rawParams: unknown): void {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string } | undefined
      // The MAIN frame only (no parent). A sub-frame navigation is not a page navigation.
      if (frame && frame.parentId === undefined) this.onNavigation?.()
    } else if (method === 'Runtime.executionContextsCleared') {
      this.onNavigation?.()
    } else if (method === 'Network.responseReceived') {
      // Main-frame DOCUMENT response only — the status the agent means by "did it load".
      if (params.type === 'Document') {
        const resp = params.response as { status?: number } | undefined
        if (resp && typeof resp.status === 'number') this.mainFrameStatus = resp.status
      }
    }
    const e: CdpEvent = { method, params }
    for (const w of [...this.waiters]) {
      if (w.match(e)) {
        this.waiters.delete(w)
        w.resolve(e)
      }
    }
  }

  /** Await the next event matching `match`, or null after `timeoutMs`. Never throws, never hangs. */
  once(match: (e: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent | null> {
    return new Promise((resolve) => {
      const waiter = {
        match,
        resolve: (e: CdpEvent | null) => {
          clearTimeout(timer)
          resolve(e)
        }
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(null)
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  /** Forget the last main-frame status — called at the start of a nav so a stale status can't be
   *  reported for the new page. */
  clearStatus(): void {
    this.mainFrameStatus = undefined
  }

  mainStatus(): number | undefined {
    return this.mainFrameStatus
  }
}

/**
 * The read chain, once: DOM.getDocument(depth:0) → DOM.resolveNode → Runtime.callFunctionOn(a FROZEN
 * NT_SCRIPTS reader, returnByValue, scalar args) → Runtime.releaseObject. The nodeId and objectId are
 * OURS (from our own getDocument/resolveNode), never the agent's; the only agent-derived data that
 * ever reaches a reader is a scalar `arguments[].value`, checked by the allowlist.
 */
async function callReader(s: Sendable, fn: string, args: readonly (string | number)[] = []): Promise<unknown> {
  const doc = (await s.send('DOM.getDocument', { depth: 0 })) as { root?: { nodeId?: number } }
  const nodeId = doc?.root?.nodeId
  if (typeof nodeId !== 'number') throw new Error('read: could not read the document root')
  const resolved = (await s.send('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
  const objectId = resolved?.object?.objectId
  if (typeof objectId !== 'string' || !objectId) throw new Error('read: could not resolve the document node')
  try {
    const res = (await s.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true
    })) as { result?: { value?: unknown } }
    return res?.result?.value
  } finally {
    // Best-effort release; a failed release must not turn a good read into an error.
    await s.send('Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

/** The final URL after navigation/redirects, from OUR navigation-history read. */
async function currentUrl(s: Sendable): Promise<string> {
  const h = (await s.send('Page.getNavigationHistory', {})) as {
    currentIndex?: number
    entries?: { url?: string }[]
  }
  const idx = typeof h?.currentIndex === 'number' ? h.currentIndex : -1
  const url = h?.entries?.[idx]?.url
  return typeof url === 'string' ? url : ''
}

async function readTitleValue(s: Sendable): Promise<string> {
  const v = await callReader(s, NT_SCRIPTS.readTitle)
  return typeof v === 'string' ? v : ''
}

/**
 * `--nav`. Navigate, wait for the load (main's own clock, never a hang), and report the final URL,
 * the main-frame status and the title. The timeout message NAMES the URL it is still at, because the
 * worst failure shape is a page that half-loaded and the agent not knowing where it is.
 */
export async function browserNav(
  s: Sendable,
  bus: CdpEventBus,
  nodeId: string,
  url: string,
  timeoutMs: number
): Promise<ActionResult> {
  await s.send('Page.enable', {})
  await s.send('Network.enable', {})
  bus.clearStatus()
  await s.send('Page.navigate', { url })
  const loaded = await bus.once((e) => e.method === 'Page.loadEventFired', timeoutMs)
  const finalUrl = await currentUrl(s)
  if (!loaded) {
    return {
      ok: false,
      message: `browser: ${nodeId} did not finish loading within ${timeoutMs}ms (still at ${finalUrl})`
    }
  }
  const status = bus.mainStatus()
  const title = await readTitleValue(s)
  const statusPart = status !== undefined ? String(status) : '?'
  return { ok: true, message: `navigated ${nodeId} → ${finalUrl} (${statusPart}, ${JSON.stringify(title)})` }
}

/** `--read title`: URL + document.title + HTTP status, one line. */
export async function browserReadTitle(s: Sendable, bus: CdpEventBus): Promise<ActionResult> {
  const title = await readTitleValue(s)
  const url = await currentUrl(s)
  const status = bus.mainStatus()
  const statusPart = status !== undefined ? ` (${status})` : ''
  return { ok: true, message: `${url} ${JSON.stringify(title)}${statusPart}`.trim() }
}

interface LinkItem {
  href?: unknown
  text?: unknown
}

/** `--read links`: `text → absolute url`, deduped, capped at 200 links / 8 KB. */
export async function browserReadLinks(s: Sendable): Promise<ActionResult> {
  const raw = (await callReader(s, NT_SCRIPTS.readLinks)) as LinkItem[] | null
  const seen = new Set<string>()
  const lines: string[] = []
  let bytes = 0
  for (const l of raw ?? []) {
    const href = typeof l?.href === 'string' ? l.href : ''
    if (!href || seen.has(href)) continue
    seen.add(href)
    const text = (typeof l?.text === 'string' ? l.text : '').replace(/\s+/g, ' ').trim()
    const line = `${text || '(no text)'} → ${href}`
    if (lines.length >= LIST_CAP || bytes + line.length + 1 > LIST_BYTES) break
    lines.push(line)
    bytes += line.length + 1
  }
  return { ok: true, message: lines.length ? lines.join('\n') : 'no links on this page' }
}

interface MapItem {
  tag?: unknown
  role?: unknown
  id?: unknown
  type?: unknown
  name?: unknown
  href?: unknown
  filled?: unknown
}

function formatMapItem(label: string, it: MapItem): string {
  const tag = typeof it.tag === 'string' ? it.tag : ''
  const role = (typeof it.role === 'string' && it.role) || tag || 'element'
  const name = (typeof it.name === 'string' ? it.name : '').replace(/\s+/g, ' ').trim()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const id = typeof it.id === 'string' && it.id ? `#${it.id}` : ''
    const type = (typeof it.type === 'string' && it.type) || tag
    // The FILL STATE, never the value (design §2.4 / Task 7.5).
    const state = it.filled ? 'filled' : 'empty'
    return `${label} ${tag}${id} (${type}, ${state})`
  }
  if (tag === 'a') {
    const href = typeof it.href === 'string' && it.href ? ` → ${it.href}` : ''
    return `${label} ${role} ${JSON.stringify(name)}${href}`
  }
  return `${label} ${role} ${JSON.stringify(name)}`
}

/**
 * `--read map`: a numbered inventory of INTERACTABLE elements only, capped 200 / 8 KB. Mints `@1…@n`
 * bound to (nodeId, current navigation generation) so a later click can spend them (Task 5.5). Role,
 * accessible name, and for a field its type and whether it is FILLED — never its value.
 */
export async function browserReadMap(s: Sendable, refs: RefTable, nodeId: string): Promise<ActionResult> {
  const raw = (await callReader(s, NT_SCRIPTS.readMap)) as MapItem[] | null
  const items = (raw ?? []).slice(0, LIST_CAP)
  // Mint at the CURRENT generation — the one this page is on, which a navigation will have bumped.
  refs.mint(nodeId, refs.currentGeneration(nodeId), items as Record<string, unknown>[])
  const lines: string[] = []
  let bytes = 0
  for (let i = 0; i < items.length; i++) {
    const line = formatMapItem(`@${i + 1}`, items[i])
    if (bytes + line.length + 1 > LIST_BYTES) break
    lines.push(line)
    bytes += line.length + 1
  }
  return { ok: true, message: lines.length ? lines.join('\n') : 'no interactable elements found' }
}

/**
 * `--read text`: rendered VISIBLE text (innerText semantics), whitespace as the page has it, scoped
 * by `--selector`. Capped by `--max` (default 20 000, ceiling 60 000); a truncation is announced
 * IN-BAND so the agent learns to narrow it. There is deliberately NO html/full-DOM mode.
 */
export async function browserReadText(
  s: Sendable,
  nodeId: string,
  selector: string | undefined,
  max: number | undefined
): Promise<ActionResult> {
  const res = (await callReader(s, NT_SCRIPTS.readText, selector ? [selector] : [])) as
    | { text?: unknown; total?: unknown }
    | null
  if (res === null) {
    return {
      ok: false,
      message: selector
        ? `browser: ${nodeId} has nothing matching ${selector}`
        : `browser: ${nodeId} has no readable document body`
    }
  }
  const cap = Math.min(max ?? READ_TEXT_DEFAULT_MAX, READ_TEXT_CEILING)
  const full = typeof res.text === 'string' ? res.text : ''
  const total = typeof res.total === 'number' ? res.total : full.length
  const text = full.slice(0, cap)
  if (total > cap) {
    return { ok: true, message: `${text}\n[truncated at ${cap} of ${total} chars — narrow it with --selector]` }
  }
  return { ok: true, message: text }
}

/** Dispatch the `--read <mode>` family. */
export async function browserRead(
  s: Sendable,
  bus: CdpEventBus,
  refs: RefTable,
  nodeId: string,
  mode: BrowserReadMode,
  opts: { selector?: string; max?: number }
): Promise<ActionResult> {
  switch (mode) {
    case 'title':
      return browserReadTitle(s, bus)
    case 'links':
      return browserReadLinks(s)
    case 'map':
      return browserReadMap(s, refs, nodeId)
    case 'text':
      return browserReadText(s, nodeId, opts.selector, opts.max)
  }
}
