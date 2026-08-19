import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const sourceBootstrap = path.resolve(__dirname, '../../bootstrap-windows.bat')
const scratchDirectories: string[] = []

interface ProbeResult {
  status: number | null
  stdout: string
  stderr: string
  installation: string
  invocations: string[]
}

function runVisualStudioProbe(vswhereBody: string): ProbeResult {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nodeterm-bootstrap-'))
  scratchDirectories.push(scratch)
  const installation = path.join(scratch, 'VS Build Tools')
  mkdirSync(installation)

  const checkout = path.join(scratch, 'checkout with spaces')
  mkdirSync(checkout)
  const bootstrap = path.join(checkout, 'bootstrap-windows.bat')
  copyFileSync(sourceBootstrap, bootstrap)

  // The space in the filename makes this fixture exercise the quoting around VSWHERE too.
  const fakeVswhere = path.join(scratch, 'fake vswhere.cmd')
  const invocationLog = path.join(scratch, 'vswhere-arguments.txt')
  writeFileSync(
    fakeVswhere,
    `@echo off\r\necho %*>>"%NODETERM_TEST_VSWHERE_ARGS_LOG%"\r\n${vswhereBody}\r\n`,
    'utf8'
  )

  const env = {
    ...process.env,
    NODETERM_BOOTSTRAP_TESTING: '1',
    NODETERM_TEST_VSWHERE: fakeVswhere,
    NODETERM_TEST_VSWHERE_ARGS_LOG: invocationLog,
    NODETERM_TEST_VS_INSTALLATION: installation
  }
  // Keep the batch path and its argument as separate argv entries. Node quotes the path for
  // CreateProcess, so a checkout directory containing spaces reaches cmd.exe intact.
  const result = spawnSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', bootstrap, '--check-vs-build-tools'],
    {
      encoding: 'utf8',
      env,
      timeout: 10_000,
      windowsHide: true
    }
  )

  expect(result.error).toBeUndefined()
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    installation,
    invocations: readFileSync(invocationLog, 'utf8').trim().split(/\r?\n/)
  }
}

const expectedVswhereArguments =
  '-products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath'

function expectVswhereInvocations(result: ProbeResult, count: number): void {
  expect(result.invocations).toEqual(Array(count).fill(expectedVswhereArguments))
}

describeWindows('bootstrap-windows Visual Studio probe', () => {
  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a successful vswhere query with empty output', () => {
    const result = runVisualStudioProbe('exit /b 0')

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      '[MISSING] No Visual Studio installation with the C++ build tools component was found.'
    )
    expect(result.stdout).not.toContain('[OK] Visual Studio C++ build tools')
    expectVswhereInvocations(result, 2)
  })

  it('keeps a failed query distinct from an empty successful query', () => {
    const result = runVisualStudioProbe('exit /b 7')

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      '[FAILED] vswhere could not query Visual Studio installations.'
    )
    expect(result.stdout).not.toContain('[MISSING] No Visual Studio installation')
    expectVswhereInvocations(result, 1)
  })

  it('rejects a reported C++ toolchain path that does not exist', () => {
    const result = runVisualStudioProbe(
      'echo %NODETERM_TEST_VS_INSTALLATION%\\missing-installation'
    )
    const missingInstallation = path.join(result.installation, 'missing-installation')

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      `[FAILED] vswhere reported a Visual Studio path that does not exist: "${missingInstallation}"`
    )
    expect(result.stdout).not.toContain('[OK] Visual Studio C++ build tools')
    expectVswhereInvocations(result, 2)
  })

  it('accepts a reported C++ toolchain path, including spaces', () => {
    const result = runVisualStudioProbe('echo %NODETERM_TEST_VS_INSTALLATION%')

    expect(result.status).toBe(0)
    expect(result.stdout, result.stderr).toContain(
      `[OK] Visual Studio C++ build tools: "${result.installation}"`
    )
    expectVswhereInvocations(result, 2)
  })
})
