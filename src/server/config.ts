import os from 'os'
import path from 'path'

/**
 * Fully-resolved server configuration. Produced by {@link resolveConfig} from the
 * process environment + CLI argv, then consumed by `startServer` (src/server/index.ts).
 */
export type ServerConfig = {
  port: number
  host: string
  dataDir: string
  rendererDir: string
  insecureHttp: boolean
  passwordSeed?: string
  /**
   * Merge the managed agent hooks into the user's real agent config dirs (~/.claude,
   * ~/.codex, ~/.gemini) at boot. Defaults to true — the server needs them to receive
   * agent status. Tests MUST pass false: the installed hook points at
   * `<dataDir>/agent-hooks/<agent>.sh`, so a temp dataDir that gets removed after the run
   * would leave a dangling hook behind in the developer's real settings.json, breaking
   * every subsequent agent session on the machine.
   */
  installHooks?: boolean
}

/**
 * Minimal `--flag value` / `--bool` argv parser. Only understands the flags we
 * define below; anything else is ignored. A flag whose next token is another
 * flag (or missing) is treated as a boolean.
 */
function parseArgv(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) continue
    const key = tok.slice(2)
    if (key === 'insecure-http') {
      out[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Resolve the server config from `env` + `argv`. Precedence is argv > env > default.
 * Binding a non-loopback host without `--insecure-http` throws: plain HTTP on a
 * public interface would leak the session cookie, so the server insists on being
 * kept behind a TLS-terminating reverse proxy (loopback) unless explicitly overridden.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig {
  const args = parseArgv(argv)

  const pick = (argKey: string, envKey: string, def: string): string => {
    if (typeof args[argKey] === 'string') return args[argKey] as string
    const ev = env[envKey]
    if (ev !== undefined && ev !== '') return ev
    return def
  }

  const port = Number(pick('port', 'NODETERM_PORT', '8443'))
  const host = pick('host', 'NODETERM_HOST', '127.0.0.1')
  const dataDir = pick('data-dir', 'NODETERM_DATA_DIR', path.join(os.homedir(), '.nodeterm-server'))
  const rendererDir = pick('renderer-dir', 'NODETERM_RENDERER_DIR', path.resolve('out/renderer'))
  const insecureHttp = args['insecure-http'] === true
  const passwordSeed = env.NODETERM_SERVER_PASSWORD || undefined

  if (!isLoopback(host) && !insecureHttp) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" over plain HTTP. Run nodeterm-server ` +
        `behind a TLS-terminating reverse proxy and keep it bound to a loopback address ` +
        `(127.0.0.1 / localhost / ::1), or pass --insecure-http to acknowledge you are ` +
        `serving plain HTTP directly on this interface.`
    )
  }

  return { port, host, dataDir, rendererDir, insecureHttp, passwordSeed }
}
