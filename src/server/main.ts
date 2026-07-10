import { resolveConfig } from './config'
import { startServer } from './index'

/**
 * Script entry point for the headless server. Kept separate from index.ts so that
 * `index.ts` stays side-effect-free (importable by tests without booting a server).
 */
async function main(): Promise<void> {
  const config = resolveConfig(process.env, process.argv.slice(2))
  const { port, close } = await startServer(config)
  const scheme = config.insecureHttp ? 'http (insecure)' : 'http'
  console.log(`nodeterm-server listening on ${scheme} ${config.host}:${port}`)

  const shutdown = (signal: string): void => {
    console.log(`\nReceived ${signal}, shutting down…`)
    void close().then(
      () => process.exit(0),
      (err) => {
        console.error('Error during shutdown:', err)
        process.exit(1)
      }
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
