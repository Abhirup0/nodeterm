import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID, timingSafeEqual } from 'crypto'
import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { platform } from '../platform'
import { canControlCanvas, type AgentId } from '../../shared/agents/config'
import { normalizeFor, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { CodexIdentityEvent } from '../../shared/types'
import { nodeTokenDir } from './node-token-files'
import { isSafeNodeId, verifyNodeToken } from './node-auth-token'

// v2 advertises NODETERM_NODE_TOKEN_DIR so clients read their per-node capability from a file
// rather than receiving it in argv. Nothing consumes the posted version server-side, so the bump
// is free; it is a marker a client can key on.
export const NODETERM_HOOK_PROTOCOL_VERSION = '2'
const SLOWLORIS_MS = 2000

// Once the body is fully read the slowloris guard has done its job — it exists for the RECEIVE
// phase (a client that dribbles bytes to pin a socket), not for the handler. But it is replaced
// with a HIGHER ceiling, never removed: a confirmation-gated control verb legitimately parks
// while the renderer waits for the user's answer, yet nothing may park forever. The desktop shell
// bounds a control request at 120s (`pendingControl` in src/main/index.ts) — a bound that lives
// OUTSIDE core, so a future core-side handler with no bound of its own would inherit an unbounded
// socket if this were `setTimeout(0)`. 130s sits comfortably above that, so in the desktop the
// handler's own timeout always wins and this only ever fires as a backstop.
const CONTROL_CEILING_MS = 130_000

// The context-link handler has no timeout of its own, and its remote leg reads over an SSH
// ControlMaster that can wedge (ConnectTimeout only covers the connect). Race it so the agent
// gets the same prose failure it would get from any other read error, instead of a session that
// blocks indefinitely — pre-fix the 2s destroy at least unblocked the agent's curl.
const CONTEXT_LINK_READ_MS = 30_000
const CONTEXT_LINK_TIMEOUT_TEXT = 'Could not read linked context.'

// Default seconds the managed permission hook holds for a phone/canvas answer before falling
// through to Claude's interactive prompt (must stay under Claude's own hook timeout). Injected
// into a claude session's env as NODETERM_PERM_WAIT_SECS when hook-reply approvals are enabled.
// See docs/hook-reply-approvals.md.
export const PERM_WAIT_SECS_DEFAULT = 45

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    // Collect Buffers and decode ONCE at the end: `data += chunk` coerced every chunk through
    // a string concat (quadratic churn on big bodies) and could split a multibyte UTF-8
    // sequence at a chunk boundary, corrupting the decoded text.
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (c: Buffer) => {
      chunks.push(c)
      bytes += c.length
      if (bytes > 5_000_000) req.destroy() // cap absurd bodies
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * Resolve to `fallback` if `p` has not settled within `ms`. The timer is always cleared, so a
 * losing race never holds the process open. There is nothing to cancel in a read already in
 * flight, so a rejection must be swallowed either way — otherwise it surfaces as an unhandled
 * rejection once the timeout has already answered. A rejection that loses no race therefore also
 * yields `fallback`, which for the context-link route means the caller reads the same prose
 * failure it gets from any other read error instead of a bare 204.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

// Parses application/x-www-form-urlencoded bodies (what the managed script posts).
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    const i = pair.indexOf('=')
    if (i < 0) continue
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '))
  }
  return out
}

/**
 * Read a /control/ request body in either dialect. The POSIX-sh shim — since it retired the Node
 * CLI, the only client there is — sends form-urlencoded: `nodeId` plus one `arg.<name>` field per
 * flag, because `curl --data-urlencode` is the only escaping sh can be trusted with (hand-built
 * JSON would break on the first quote in a `--prompt` or `--html` value). The JSON dialect is
 * kept because the route is a stable local API that a session predating an app upgrade may still
 * be holding a copy of. Exported for tests.
 */
export function parseControlBody(
  raw: string,
  contentType: string
): { nodeId: string; args: Record<string, string> } {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = parseForm(raw)
    const args: Record<string, string> = {}
    for (const [k, v] of Object.entries(form)) {
      if (k.startsWith('arg.') && k.length > 4) args[k.slice(4)] = v
    }
    return { nodeId: form.nodeId ?? '', args }
  }
  try {
    const parsed = JSON.parse(raw) as { nodeId?: string; args?: Record<string, string> }
    return { nodeId: parsed.nodeId ?? '', args: parsed.args ?? {} }
  } catch {
    return { nodeId: '', args: {} }
  }
}

/**
 * What the hook server knows about the POST an event arrived on, beyond the event itself.
 *
 * `verified` = the caller presented a per-node token THIS instance minted for THAT node id. It is
 * a LABEL, nothing more: `false` is the overwhelmingly common, entirely legitimate case (any client
 * that predates the token, the phone, a cross-instance failover), so nothing may gate behaviour on
 * it. A later task makes the label useful; until then, false must cost a caller nothing.
 */
export interface HookEventMeta {
  verified: boolean
}

class HookServer {
  private server: Server | null = null
  private port = 0
  private token = ''
  private listener: ((e: NormalizedAgentEvent) => void) | null = null
  private rawListener:
    | ((
        agentId: string,
        nodeId: string,
        payload: Record<string, unknown>,
        meta: HookEventMeta
      ) => void)
    | null = null
  /**
   * Nodes that have presented a token this instance minted for THAT node id. In memory only and
   * deliberately so: it is a record of what happened on this process's socket, not a durable claim,
   * and a restart must re-earn it. Bounded by the number of node ids that ever post here.
   */
  private provenNodes = new Set<string>()
  private controlHandler:
    | ((cmd: { verb: string; nodeId: string; args: Record<string, string> }) => Promise<{
        ok: boolean
        message?: string
        result?: unknown
        error?: string
      }>)
    | null = null
  // Context-link reads. Same shape as the control handler, but it answers with TEXT (a rendered
  // transcript / summary / terminal capture) rather than acting on the canvas.
  private contextLinkHandler:
    | ((req: { verb: string; nodeId: string; args: Record<string, string> }) => Promise<string>)
    | null = null
  /**
   * The shared-identity spine's handlers (see core/codex-identity-proxy.ts). Both are injected by
   * the shell, and BOTH routes below additionally require a per-node capability — see
   * `nodeTokenVerified`.
   */
  private codexThreadStartHandler:
    | ((req: { nodeId: string; cwd: string; hookEndpoint: string }) => Promise<string>)
    | null = null
  private codexThreadBindHandler:
    | ((req: { nodeId: string; threadId: string; hookEndpoint: string }) => Promise<void>)
    | null = null
  private codexIdentityListener: ((e: CodexIdentityEvent) => void) | null = null
  private endpointPath = ''
  private nodeAuthSecret: Buffer | null = null

  endpointFilePath(): string {
    if (!this.endpointPath) this.endpointPath = path.join(platform().userDataDir, 'hook-endpoint.env')
    return this.endpointPath
  }

  getPort(): number {
    return this.port
  }
  getToken(): string {
    return this.token
  }
  getVersion(): string {
    return NODETERM_HOOK_PROTOCOL_VERSION
  }

  setListener(cb: (e: NormalizedAgentEvent) => void): void {
    this.listener = cb
  }

  // Raw payload listener: receives the parsed (un-normalized) hook JSON. Drives the
  // contextTail/subagentTail features, which need transcript_path (not in NormalizedAgentEvent).
  // `meta` carries what the transport knows about the caller (see HookEventMeta).
  setRawListener(
    cb: (
      agentId: string,
      nodeId: string,
      payload: Record<string, unknown>,
      meta: HookEventMeta
    ) => void
  ): void {
    this.rawListener = cb
  }

  /** Has this node ever posted with a token this instance minted for it? Read by the routing task
   *  that consumes the label; never a gate on /hook/* itself. */
  isNodeProven(nodeId: string): boolean {
    return this.provenNodes.has(nodeId)
  }

  setControlHandler(cb: NonNullable<HookServer['controlHandler']>): void {
    this.controlHandler = cb
  }

  setContextLinkHandler(cb: NonNullable<HookServer['contextLinkHandler']>): void {
    this.contextLinkHandler = cb
  }

  setCodexThreadStartHandler(cb: NonNullable<HookServer['codexThreadStartHandler']>): void {
    this.codexThreadStartHandler = cb
  }

  setCodexThreadBindHandler(cb: NonNullable<HookServer['codexThreadBindHandler']>): void {
    this.codexThreadBindHandler = cb
  }

  /** Where a node's identity mode goes on its way to the UI (both shells forward it). */
  setCodexIdentityListener(cb: (e: CodexIdentityEvent) => void): void {
    this.codexIdentityListener = cb
  }

  /**
   * The shell injects a restart-stable node-auth secret before any identity-scoped PTY is created —
   * sealed via safeStorage on the desktop, raw 0600 bytes on the Server Edition (see
   * core/agents/node-auth-secret.ts). Called on BOTH shells at boot. Rejects a secret under 32
   * bytes so a truncated/garbage load can never arm a weak identity.
   */
  setNodeAuthSecret(secret: Uint8Array): void {
    if (secret.byteLength < 32) throw new Error('Invalid NodeTerm node-auth secret')
    this.nodeAuthSecret = Buffer.from(secret)
  }

  /** True once a valid secret is set; false before, and after a failed load (nothing was set). The
   *  later routing tasks gate every identity-scoped decision on this. */
  identityAvailable(): boolean {
    return !!this.nodeAuthSecret
  }

  /** The raw secret for the routing tasks that must derive/verify per-node capabilities themselves,
   *  or null when identity is unavailable (legacy mode). Callers must handle null — never throw. */
  nodeAuthSecretOrNull(): Buffer | null {
    return this.nodeAuthSecret
  }

  /** Test seam only: this server is a module singleton, so its secret otherwise leaks across tests. */
  clearNodeAuthSecretForTests(): void {
    this.nodeAuthSecret = null
  }

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomUUID()
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Hooks fail open: any error path still ends 204 so a broken hook never blocks the agent.
      try {
        if (req.method !== 'POST') {
          res.writeHead(404)
          res.end()
          return
        }
        if (!this.tokenMatches(req.headers['x-nodeterm-hook-token'])) {
          res.writeHead(403)
          res.end()
          return
        }
        req.setTimeout(SLOWLORIS_MS, () => req.destroy())
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        // THE TUNNEL PROBE. `RemoteHooks.verifyTunnel` curls this through the reverse socket and
        // requires exactly 204 before it will write the remote endpoint file or install a single
        // hook script. It proves ONE thing — the socket reaches this server — and it must answer on
        // the bearer alone, with no node identity of any kind, permanently: the caller is the
        // desktop itself, `verify` is not a node id, and a 403 here would silently cost that host
        // its whole remote hook + skill install.
        //
        // Until this route existed, `/hook/verify` 204'd only because the probe sends no `payload`
        // field and fell out of the generic branch — a coincidence that the identity label on
        // `/hook/*` would have turned into a 403 for any probe carrying a token. `/hook/verify`
        // therefore stays answering forever: a host connected by an older desktop still has that
        // path baked into the script on its disk.
        if (reqUrl.pathname === '/verify' || reqUrl.pathname === '/hook/verify') {
          await readBody(req) // drain, so the probe's body is never left unread on the socket
          res.writeHead(204)
          res.end()
          return
        }
        if (reqUrl.pathname.startsWith('/codex-thread/')) {
          await this.handleCodexThread(reqUrl.pathname, req, res)
          return
        }
        if (reqUrl.pathname.startsWith('/control/')) {
          const verb = decodeURIComponent(reqUrl.pathname.replace(/^\/control\//, ''))
          const { nodeId, args } = parseControlBody(
            await readBody(req),
            String(req.headers['content-type'] ?? '')
          )
          // Body fully received: hand the socket from the receive-phase guard to the much larger
          // handler ceiling. A destructive control verb parks here for as long as the user takes
          // to answer the confirmation dialog, and the 2s guard used to destroy the socket mid-
          // dialog — the caller saw "endpoint unreachable" while the dialog was still up, and a
          // late confirm still delivered, so the agent was told nothing happened when it had.
          req.setTimeout(CONTROL_CEILING_MS, () => req.destroy())
          const result = this.controlHandler
            ? await this.controlHandler({ verb, nodeId, args })
            : { ok: false, error: 'control unavailable' }
          // The POSIX-sh shim asks for text/plain: it has no JSON parser, so the server does the
          // rendering the Node CLI used to do client-side. Everything else keeps the JSON shape.
          if (String(req.headers.accept ?? '').includes('text/plain')) {
            const text = result.ok
              ? result.message ?? JSON.stringify(result.result ?? {})
              : result.error ?? 'control request failed'
            res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`${text}\n`)
            return
          }
          res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
          return
        }
        if (reqUrl.pathname.startsWith('/context-link/')) {
          const verb = decodeURIComponent(reqUrl.pathname.replace(/^\/context-link\//, ''))
          const { nodeId, args } = parseControlBody(
            await readBody(req),
            String(req.headers['content-type'] ?? '')
          )
          // Same hand-off as /control/: the receive phase is over, so raise the guard to the
          // handler ceiling rather than dropping it. The effective bound here is the race below;
          // the socket ceiling is only the backstop behind it.
          req.setTimeout(CONTROL_CEILING_MS, () => req.destroy())
          // Always text: the caller is the sh shim, and the payload IS prose (a rendered
          // transcript). The handler owns the authorization — see context-link.ts.
          const text = this.contextLinkHandler
            ? await withTimeout(
                this.contextLinkHandler({ verb, nodeId, args }),
                CONTEXT_LINK_READ_MS,
                CONTEXT_LINK_TIMEOUT_TEXT
              )
            : 'Context link is unavailable in this session.'
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`${text}\n`)
          return
        }
        const agentId = decodeURIComponent(reqUrl.pathname.replace(/^\/hook\//, ''))
        const form = parseForm(await readBody(req))
        const nodeId = form.nodeId ?? ''
        // Identity is a LABEL here, not a gate. The three-way verdict maps to:
        //   forged  — our own kid with a mac that is not this node's ⇒ 403. Nothing legitimate can
        //             produce it (only a holder of a token for ANOTHER node, or a mutation of one),
        //             so it is the single case this route refuses.
        //   legacy  — no token, or another instance's kid. THE COMMON CASE, and it must keep
        //             behaving exactly as it did before this label existed: 204, listeners fired.
        //             Every client that predates the token, the phone, and the documented
        //             cross-instance failover land here. Do not gate this on identityAvailable(),
        //             on the agent, or on anything else — the fail-open is the contract.
        //   verified — the caller holds this node's token; remember the node and pass the flag on.
        const verdict = verifyNodeToken(
          this.nodeAuthSecretOrNull(),
          nodeId,
          req.headers['x-nodeterm-node-token']
        )
        if (verdict === 'forged') {
          res.writeHead(403)
          res.end()
          return
        }
        const verified = verdict === 'verified'
        if (verified) this.provenNodes.add(nodeId)
        if (agentId && nodeId && form.payload) {
          let payload: Record<string, unknown> = {}
          try {
            payload = JSON.parse(form.payload) as Record<string, unknown>
          } catch {
            payload = {}
          }
          // Deterministic-approval ticket: the managed permission hook adds `nodeterm_pending_id`
          // as a separate form field (it can't edit the agent's JSON payload in POSIX sh). Merge it
          // into the payload object so both the raw listener and the normalizers see it as if it
          // rode inside the hook JSON. See docs/hook-reply-approvals.md.
          if (form.nodeterm_pending_id) payload.nodeterm_pending_id = form.nodeterm_pending_id
          // Same treatment for the "answered" signal the wait branch fires on a valid allow/deny
          // answer (a separate form field it can't fold into the agent's JSON in POSIX sh). Merged
          // so the normalizer sees it and maps it to a synthetic working transition. See
          // docs/hook-reply-approvals.md.
          if (form.nodeterm_answered) payload.nodeterm_answered = form.nodeterm_answered
          // Raw listener first: it drives the transcript-tailing features (which need
          // transcript_path). Inside the try so a throwing raw listener still ends 204.
          this.rawListener?.(agentId, nodeId, payload, { verified })
          const normalized = normalizeFor(agentId, { nodeId, agentId, payload })
          if (normalized && this.listener) this.listener({ ...normalized, verified })
        }
        res.writeHead(204)
        res.end()
      } catch {
        res.writeHead(204)
        res.end()
      }
    })
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => {
        this.server?.off('listening', onOk)
        reject(e)
      }
      const onOk = (): void => {
        this.server?.off('error', onErr)
        this.server?.on('error', (e) => console.error('[agent-hooks] server error', e))
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        this.writeEndpointFile()
        resolve()
      }
      this.server!.once('error', onErr)
      this.server!.listen(0, '127.0.0.1', onOk)
    })
  }

  // Constant-time bearer-token check (avoids a timing side channel on the compare).
  private tokenMatches(provided: string | string[] | undefined): boolean {
    if (typeof provided !== 'string' || !this.token) return false
    const a = Buffer.from(provided)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * The identity routes' gate: ONE derivation, the same `verifyNodeToken` /hook/* is labelled by.
   *
   * These routes are STRICT — only `verified` proceeds. `legacy` (no token, an empty header,
   * another instance's kid, no secret at all) is refused here, deliberately and unlike /hook/*:
   * they were strict from the day they existed, so there is no upgrade population to protect. A
   * session that predates the per-node capability has no launcher that calls `/codex-thread/*` at
   * all; failing it open would buy nothing and hand back the authorization hole the capability
   * exists to close (any session holding the shared bearer binding its own codex thread to a
   * SIBLING node — reparenting that node's status and, through the hook prelude which re-exports
   * the recorded node id and endpoint, aiming that node's hook traffic).
   */
  private nodeTokenVerified(nodeId: string, provided: string | string[] | undefined): boolean {
    return verifyNodeToken(this.nodeAuthSecretOrNull(), nodeId, provided) === 'verified'
  }

  /**
   * `/codex-thread/{start,bind,fallback}`.
   *
   * start/bind are the identity spine and require the per-node capability on top of the shared
   * bearer. `fallback` deliberately does NOT: it is the launcher telling us it gave up and is
   * running plain codex, it grants nothing, and requiring a token there would silence the report
   * in exactly the case (no token) it exists to surface.
   */
  private async handleCodexThread(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const verb = pathname.replace(/^\/codex-thread\//, '')
    const form = parseForm(await readBody(req))
    // SAME HAND-OFF as /control/ and /context-link/, and for the same reason — this route needs it
    // MOST. The receive phase is over, so the 2s slowloris guard has done its job; leaving it armed
    // destroys the socket while the HANDLER is still working. `/codex-thread/start` mints a thread
    // through a five-step conversation with the app-server (initialize, start, a turn, an
    // interrupt, a fork, a delete) against a server that is typically COLD — the first codex node
    // after boot is the common case, not the edge one. At 2s that fails every time, and it fails in
    // the worst possible way: curl gives up, the launcher falls back to plain codex, and main goes
    // on to create the thread and write a record for it — an orphan thread plus an orphan record
    // per attempt. The client budget is deliberately set ABOVE the server's own (see
    // CODEX_THREAD_START_TIMEOUT_MS / the launcher's --max-time) so the server is always the one
    // that gives up first and can clean up after itself.
    req.setTimeout(CONTROL_CEILING_MS, () => req.destroy())
    const nodeId = form.nodeId ?? ''
    // `isSafeNodeId`, not a local regex: the same predicate the token derivation and the token
    // FILE path use, so an id one of them would refuse can never reach the other two.
    if (!isSafeNodeId(nodeId)) {
      res.writeHead(400)
      res.end()
      return
    }
    if (verb === 'fallback') {
      // This is the ONE route that may be called without the per-node capability, because the
      // commonest thing it reports is "there was no capability to present" — requiring one would
      // silence it in exactly the case it exists for. That exemption is as narrow as it can be
      // made: a report that DOES carry a token must have the right one, so only a tokenless caller
      // is trusted on the nodeId it names. Without this a session holding the shared bearer could
      // flag a sibling node as fallen back. Cosmetic (the flag is transient and downgrade-only),
      // but a claim in a comment has to be true.
      const token = req.headers['x-nodeterm-node-token']
      if (token !== undefined && !this.nodeTokenVerified(nodeId, token)) {
        res.writeHead(403)
        res.end()
        return
      }
      // A reason is free text from a generated script we wrote; bound it and let the UI show it.
      const reason = (form.reason ?? '').slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '') || 'unknown'
      this.codexIdentityListener?.({ nodeId, mode: 'plain', reason })
      res.writeHead(204)
      res.end()
      return
    }
    if (verb !== 'start' && verb !== 'bind') {
      res.writeHead(404)
      res.end()
      return
    }
    if (!this.nodeTokenVerified(nodeId, req.headers['x-nodeterm-node-token'])) {
      res.writeHead(403)
      res.end()
      return
    }
    if (verb === 'start') {
      const cwd = form.cwd ?? ''
      if (!path.isAbsolute(cwd)) {
        res.writeHead(400)
        res.end()
        return
      }
      try {
        if (!this.codexThreadStartHandler) throw new Error('start handler unavailable')
        const threadId = await this.codexThreadStartHandler({
          nodeId,
          cwd,
          hookEndpoint: this.endpointFilePath()
        })
        if (!/^[A-Za-z0-9._-]+$/.test(threadId)) throw new Error('invalid thread id')
        this.codexIdentityListener?.({ nodeId, mode: 'shared' })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`${threadId}\n`)
      } catch {
        res.writeHead(503)
        res.end()
      }
      return
    }
    const threadId = form.threadId ?? ''
    if (!/^[A-Za-z0-9._-]+$/.test(threadId)) {
      res.writeHead(400)
      res.end()
      return
    }
    try {
      if (!this.codexThreadBindHandler) throw new Error('bind handler unavailable')
      await this.codexThreadBindHandler({
        nodeId,
        threadId,
        hookEndpoint: this.endpointFilePath()
      })
      this.codexIdentityListener?.({ nodeId, mode: 'shared' })
      res.writeHead(204)
      res.end()
    } catch {
      res.writeHead(409)
      res.end()
    }
  }

  // The managed script sources this file at invocation to get the LIVE port/token.
  // tmux sessions outlive the app, so env-baked coords go stale after a restart.
  private writeEndpointFile(): void {
    try {
      const p = this.endpointFilePath()
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(
        p,
        `NODETERM_HOOK_PORT=${this.port}\n` +
          `NODETERM_HOOK_TOKEN=${this.token}\n` +
          `NODETERM_HOOK_VERSION=${NODETERM_HOOK_PROTOCOL_VERSION}\n` +
          // Where clients read their PER-NODE capability from, keyed by $NODETERM_NODE_ID.
          // Advertised (not compiled in) so a failover that sources ANOTHER instance's endpoint
          // file also picks up THAT instance's token dir: it then finds a token that instance can
          // verify, or none — never a mismatched one.
          `NODETERM_NODE_TOKEN_DIR=${nodeTokenDir()}\n`,
        // 0o600: this file holds the bearer token — owner read/write only so another local user
        // can't read it and forge hook events.
        { encoding: 'utf8', mode: 0o600 }
      )
    } catch (e) {
      console.warn('[agent-hooks] could not write endpoint file', e)
    }
  }

  // `permWaitSecs > 0` opts this session into the deterministic hook-reply approval flow: the
  // managed permission hook holds for that many seconds for a phone/canvas answer file before
  // falling through to Claude's interactive prompt. 0/undefined ⇒ NODETERM_PERM_WAIT_SECS absent ⇒
  // the hook's wait-branch is inert (exact legacy behavior). See docs/hook-reply-approvals.md.
  buildPtyEnv(nodeId: string, agentId: AgentId, permWaitSecs = 0): Record<string, string> {
    if (this.port <= 0 || !this.token) return {}
    return {
      // NO NODETERM_HOOK_TOKEN, NO NODETERM_HOOK_PORT — measured 2026-08-13: these ride the tmux
      // `-e` argv into a long-lived tmux CLIENT process whose /proc/<pid>/cmdline is mode 444 on a
      // stock Linux (no hidepid), so any unprivileged local user read a live app-wide bearer and
      // could drive canvas control — including `open-terminal --cmd`, which is NOT in the
      // confirm-gated DESTRUCTIVE set. Every client already sources the 0600 endpoint file FIRST
      // and prefers it, so nothing legitimate loses anything: the only regression surface is a
      // session whose endpoint file is unreadable AND whose env held a good token, a state that
      // means the data dir has vanished and the hook is meant to be inert anyway.
      NODETERM_HOOK_VERSION: NODETERM_HOOK_PROTOCOL_VERSION,
      NODETERM_HOOK_ENDPOINT: this.endpointFilePath(),
      NODETERM_NODE_ID: nodeId,
      NODETERM_AGENT_ID: agentId,
      ...(permWaitSecs > 0 ? { NODETERM_PERM_WAIT_SECS: String(permWaitSecs) } : {}),
      ...(canControlCanvas(agentId) ? { NODETERM_CANVAS_CONTROL: '1' } : {})
      // NO NODETERM_CODEX_NODE_TOKEN either. The per-node capability is the same class of leak as
      // the app-wide bearer above, and a worse one to reason about: it is the credential that
      // proves WHICH node is calling, so a sibling uid reading it off /proc/<pid>/cmdline could
      // bind its own codex thread to that node — the exact reparenting this capability exists to
      // prevent. It reaches the client through the 0600 token file instead (nodeTokenDir(), keyed
      // by $NODETERM_NODE_ID and advertised in the endpoint file) — where the launcher
      // (core/codex-identity-proxy.ts) reads it, exactly as the managed script and both sh shims
      // do, so shared identity is LIVE with no credential in anyone's argv.
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
  }
}

export const hookServer = new HookServer()
