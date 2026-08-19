// Bundle the Codex relay daemon into a STANDALONE `codex-relay.js` that runs under a bare `node` on
// an SSH host — ws inlined, no node_modules required on the far side. This is the artifact the
// desktop uploads to a Linux host (`installRemoteCodexRuntime`); it is executable code only, never
// a credential (S6 Property 1). Runs AFTER `electron-vite build`, writing into `out/main/` so
// `codexRelaySource()` can read it beside the main entry (`path.join(__dirname, 'codex-relay.js')`)
// in both dev and a packaged asar, and so electron-builder's `out/**/*` picks it up.
//
// Unlike `server:build` (which keeps `ws` external because the server runs from a node_modules
// tree), this bundle inlines `ws` — the remote host has node but not our dependencies. Verified
// runnable over real SSH against codex-cli 0.146.0 (docs/superpowers/probes/2026-08-codex-ssh-remote.md).
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [resolve(root, 'src/main/codex-relay-daemon.ts')],
  outfile: resolve(root, 'out/main/codex-relay.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // node-pty is never reached by the relay; keep it external so its native require() is not bundled.
  external: ['node-pty'],
  tsconfig: resolve(root, 'tsconfig.node.json'),
  logLevel: 'info'
})
