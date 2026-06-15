import { execFile, execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import { promisify } from 'util'
import type { GitResult, Settings } from '../shared/types'

const run = promisify(execFile)

const STAGED_DIFF_BYTE_BUDGET = 200_000
const OUTPUT_LIMIT = 64_000
const TIMEOUT_MS = 120_000

const bytes = (s: string) => Buffer.byteLength(s, 'utf-8')

/** Resolve a CLI binary to an absolute path (GUI apps don't inherit the shell PATH). */
function resolveBinary(name: string): string | null {
  if (name.startsWith('/')) return fs.existsSync(name) ? name : null
  const candidates = [
    `${os.homedir()}/.local/bin/${name}`,
    `${os.homedir()}/.claude/local/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  try {
    const out = execFileSync(process.env.SHELL || '/bin/bash', ['-lc', `command -v ${name}`], {
      encoding: 'utf-8'
    }).trim()
    if (out) return out
  } catch {
    // ignore
  }
  return null
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/**
 * Split a unified diff into per-file chunks (each starting at a `diff --git` header) and
 * fairly distribute a byte budget across them ("water-filling"), so one giant generated
 * file (lockfile etc.) can't starve the human-written changes. Each cut is on a line
 * boundary with a marker; the agent never sees a half line.
 */
function truncateDiffForPrompt(diff: string, budget: number): string {
  if (bytes(diff) <= budget) return diff

  const chunks: string[] = []
  const re = /(^|\n)(diff --git )/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  const starts: number[] = []
  while ((m = re.exec(diff))) starts.push(m.index + (m[1] ? 1 : 0))
  if (starts.length === 0) return capAtLine(diff, budget)
  for (let i = 0; i < starts.length; i++) {
    chunks.push(diff.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : diff.length))
  }
  lastIndex = starts[0]
  const preamble = diff.slice(0, lastIndex)

  // Water-fill: smallest files first take their full size; the rest share what remains.
  let remaining = budget - bytes(preamble)
  let left = chunks.length
  const caps = new Array<number>(chunks.length)
  chunks
    .map((c, i) => ({ i, size: bytes(c) }))
    .sort((a, b) => a.size - b.size)
    .forEach(({ i, size }) => {
      const share = Math.max(0, Math.floor(remaining / Math.max(1, left)))
      const take = Math.min(size, share)
      caps[i] = take
      remaining -= take
      left--
    })

  return preamble + chunks.map((c, i) => capAtLine(c, caps[i])).join('')
}

function capAtLine(text: string, cap: number): string {
  if (bytes(text) <= cap) return text
  let cut = Buffer.from(text, 'utf-8').slice(0, Math.max(0, cap)).toString('utf-8')
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl)
  const omitted = bytes(text) - bytes(cut)
  return `${cut}\n...(diff truncated, ${omitted} bytes omitted)\n`
}

function buildPrompt(diff: string, files: string, extra: string): string {
  const base = `Write a git commit message for the staged changes below.
Output ONLY the commit message - no preamble, no code fences, no quotes.
Use a concise subject line of at most 72 characters; if useful, add a blank line then a short body.
Do not include "Co-authored-by" trailers.`
  const body = diff
    ? `\n\nStaged diff:\n\`\`\`diff\n${diff}\n\`\`\``
    : `\n\nStaged files (diff omitted due to size):\n${files}`
  const suffix = extra.trim() ? `\n\nAdditional user prompt:\n${extra.trim()}` : ''
  return base + body + suffix
}

/** Split a command template into tokens (quote-aware, NO shell expansion). */
function tokenize(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

interface Plan {
  bin: string
  args: string[]
  stdin: string | null
}

function planAgent(settings: Settings, prompt: string): Plan | { error: string } {
  if (settings.commitAgent === 'custom') {
    const tokens = tokenize(settings.commitAgentCommand)
    if (tokens.length === 0) return { error: 'No custom commit command set (Settings → Commit messages).' }
    const bin = resolveBinary(tokens[0])
    if (!bin) return { error: `Command "${tokens[0]}" not found.` }
    const rest = tokens.slice(1)
    if (rest.includes('{prompt}')) {
      return { bin, args: rest.map((t) => (t === '{prompt}' ? prompt : t)), stdin: null }
    }
    return { bin, args: rest, stdin: prompt }
  }
  if (settings.commitAgent === 'codex') {
    const bin = resolveBinary('codex')
    if (!bin) return { error: 'codex CLI not found.' }
    return { bin, args: ['exec', '--sandbox', 'read-only'], stdin: prompt }
  }
  const bin = resolveBinary('claude')
  if (!bin) return { error: 'claude CLI not found. Install Claude Code or pick another agent in Settings.' }
  return { bin, args: ['-p', '--permission-mode', 'plan'], stdin: prompt }
}

function spawnAgent(
  bin: string,
  args: string[],
  cwd: string,
  stdin: string | null
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: stderr || String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    if (stdin !== null) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

/** Strip CLI noise (ANSI, status lines, wrapping fence, quotes) to leave the message. */
function cleanMessage(raw: string): string {
  let s = raw.replace(ANSI, '').trim()
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fence) s = fence[1].trim()
  const noise = /^(generating|thinking|loading|analyzing|working|reading|here'?s|sure[,.!]?|okay|certainly|i'?ll|let me)\b/i
  const lines = s.split('\n')
  while (lines.length && noise.test(lines[0].trim())) lines.shift()
  s = lines.join('\n').trim()
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim()
  return s
}

function extractError(text: string): string {
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const meaningful = lines.reverse().find((l) => /error|fail|denied|not found|429|unauthor/i.test(l))
  return meaningful || lines[0] || 'Agent produced no output.'
}

/** Orchestrates: staged diff -> budget -> prompt -> read-only agent spawn -> clean message. */
export async function generateCommitMessage(cwd: string, settings: Settings): Promise<GitResult> {
  if (!cwd) return { ok: false, message: 'No project folder set.' }

  const names = (await git(cwd, ['diff', '--cached', '--name-status'])).trim()
  if (!names) return { ok: false, message: 'No staged changes. Stage files first.' }

  const rawDiff = await git(cwd, ['diff', '--cached', '--patch', '--minimal'])
  const diff = rawDiff ? truncateDiffForPrompt(rawDiff, STAGED_DIFF_BYTE_BUDGET) : ''
  const prompt = buildPrompt(diff, names, settings.commitExtraPrompt)

  const plan = planAgent(settings, prompt)
  if ('error' in plan) return { ok: false, message: plan.error }

  const res = await spawnAgent(plan.bin, plan.args, cwd, plan.stdin)
  const message = cleanMessage(res.stdout)
  if (res.code !== 0 && !message) {
    return { ok: false, message: extractError(res.stderr || res.stdout) }
  }
  if (!message) return { ok: false, message: 'Agent produced no commit message.' }
  return { ok: true, message }
}
