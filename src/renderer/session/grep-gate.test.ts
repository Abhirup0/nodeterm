import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

// The seven grep-gated namespaces + the agent event streams migrated in 4a. No production renderer
// file OUTSIDE the session layer may read these off window.nodeTerminal — they come from the
// session (`useSession().api` in components, `activeSessionApi()` in non-component code). The
// bridge (src/renderer/bridge/) is exempt because it IMPLEMENTS window.nodeTerminal for the
// browser, and the session layer (src/renderer/session/) is exempt because localSession.ts is the
// one place that captures the global by identity.
const FORBIDDEN =
  /window\.nodeTerminal\.(pty|git|fs|workspace|presence|chat|canvas|onAgentStatus|onSubagentActivity|onAgentControl|sendAgentControlResult)\b/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

describe('grep gate: core-bound namespaces are read from the session, not the global', () => {
  it('no production renderer file reads a migrated namespace off window.nodeTerminal', () => {
    const root = join(__dirname, '..') // src/renderer
    const offenders: string[] = []
    for (const f of walk(root)) {
      // The session layer captures the global by design; the bridge implements it.
      if (f.includes(`${sep}session${sep}`) || f.includes(`${sep}bridge${sep}`)) continue
      const src = readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        // Comment-only lines are prose (docs that NAME the global are fine — reading it is not).
        // Only lines that START as comments are skipped, so a read with a trailing comment,
        // or any actual code, is always scanned.
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        if (FORBIDDEN.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, `Read these from useSession().api instead:\n${offenders.join('\n')}`).toEqual(
      []
    )
  })
})
