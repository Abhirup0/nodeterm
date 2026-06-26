import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID, timingSafeEqual } from 'crypto'
import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { app } from 'electron'
import type { AgentId } from '../../shared/agents/config'
import { normalizeFor, type NormalizedAgentEvent } from '../../shared/agents/normalize'

export const NODETERM_HOOK_PROTOCOL_VERSION = '1'
const SLOWLORIS_MS = 2000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 5_000_000) req.destroy() // cap absurd bodies
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
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

class HookServer {
  private server: Server | null = null
  private port = 0
  private token = ''
  private listener: ((e: NormalizedAgentEvent) => void) | null = null
  private rawListener: ((agentId: string, nodeId: string, payload: Record<string, unknown>) => void) | null = null
  private endpointPath = ''

  endpointFilePath(): string {
    if (!this.endpointPath) this.endpointPath = path.join(app.getPath('userData'), 'hook-endpoint.env')
    return this.endpointPath
  }

  setListener(cb: (e: NormalizedAgentEvent) => void): void {
    this.listener = cb
  }

  // Raw payload listener: receives the parsed (un-normalized) hook JSON. Drives the
  // contextTail/subagentTail features, which need transcript_path (not in NormalizedAgentEvent).
  setRawListener(cb: (agentId: string, nodeId: string, payload: Record<string, unknown>) => void): void {
    this.rawListener = cb
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
        const agentId = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/hook\//, ''))
        const form = parseForm(await readBody(req))
        const nodeId = form.nodeId ?? ''
        if (agentId && nodeId && form.payload) {
          let payload: Record<string, unknown> = {}
          try {
            payload = JSON.parse(form.payload) as Record<string, unknown>
          } catch {
            payload = {}
          }
          // Raw listener first: it drives the transcript-tailing features (which need
          // transcript_path). Inside the try so a throwing raw listener still ends 204.
          this.rawListener?.(agentId, nodeId, payload)
          const normalized = normalizeFor(agentId, { nodeId, agentId, payload })
          if (normalized && this.listener) this.listener(normalized)
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

  // The managed script sources this file at invocation to get the LIVE port/token.
  // tmux sessions outlive the app, so env-baked coords go stale after a restart.
  private writeEndpointFile(): void {
    try {
      const p = this.endpointFilePath()
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(
        p,
        `NODETERM_HOOK_PORT=${this.port}\nNODETERM_HOOK_TOKEN=${this.token}\nNODETERM_HOOK_VERSION=${NODETERM_HOOK_PROTOCOL_VERSION}\n`,
        // 0o600: this file holds the bearer token — owner read/write only so another local user
        // can't read it and forge hook events.
        { encoding: 'utf8', mode: 0o600 }
      )
    } catch (e) {
      console.warn('[agent-hooks] could not write endpoint file', e)
    }
  }

  buildPtyEnv(nodeId: string, agentId: AgentId): Record<string, string> {
    if (this.port <= 0 || !this.token) return {}
    return {
      NODETERM_HOOK_PORT: String(this.port),
      NODETERM_HOOK_TOKEN: this.token,
      NODETERM_HOOK_VERSION: NODETERM_HOOK_PROTOCOL_VERSION,
      NODETERM_HOOK_ENDPOINT: this.endpointFilePath(),
      NODETERM_NODE_ID: nodeId,
      NODETERM_AGENT_ID: agentId
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
