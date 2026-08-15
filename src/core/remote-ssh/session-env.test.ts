import { describe, expect, it } from 'vitest'
import {
  isSafeEnvName,
  remoteSessionEnvPath,
  sessionEnvFileContent
} from './session-env'

describe('sessionEnvFileContent', () => {
  it('renders `export K=\'v\'` with values single-quoted so metacharacters are inert', () => {
    const out = sessionEnvFileContent({
      ANTHROPIC_AUTH_TOKEN: 'vk-123',
      OPENAI_BASE_URL: 'https://gw.example/v1'
    })
    expect(out).toBe(
      "export ANTHROPIC_AUTH_TOKEN='vk-123'\nexport OPENAI_BASE_URL='https://gw.example/v1'\n"
    )
  })

  it('fences a hostile value into a single-quoted literal (no command substitution escapes)', () => {
    const out = sessionEnvFileContent({ K: "a'; rm -rf ~; echo '" })
    // The embedded quote is closed/escaped/reopened, never terminating the assignment.
    expect(out).toBe("export K='a'\\''; rm -rf ~; echo '\\'''\n")
  })

  it('drops a pair whose NAME is not a shell identifier (a name is spliced bare)', () => {
    const out = sessionEnvFileContent({ 'BAD;NAME': 'x', GOOD: 'y' })
    expect(out).toBe("export GOOD='y'\n")
  })
})

describe('isSafeEnvName', () => {
  it('accepts identifiers, rejects anything that could break out of the left-hand side', () => {
    expect(isSafeEnvName('ANTHROPIC_AUTH_TOKEN')).toBe(true)
    expect(isSafeEnvName('_x1')).toBe(true)
    expect(isSafeEnvName('1BAD')).toBe(false)
    expect(isSafeEnvName('BAD;NAME')).toBe(false)
    expect(isSafeEnvName('BAD NAME')).toBe(false)
    expect(isSafeEnvName('')).toBe(false)
  })
})

describe('remoteSessionEnvPath', () => {
  it('builds a per-session path under the validated remote home', () => {
    expect(remoteSessionEnvPath('/home/deploy', 'nt-abc')).toBe(
      '/home/deploy/.nodeterm/env/nt-abc.env'
    )
  })
})
