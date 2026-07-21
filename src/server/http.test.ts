import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Auth } from './auth'
import { createHttpHandler, sessionTokenFromCookie, SESSION_COOKIE } from './http'
import { parseTrustedNets } from './proxy-trust'

let dir: string, rendererDir: string, server: http.Server, base: string, auth: Auth

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-http-'))
  rendererDir = path.join(dir, 'renderer')
  fs.mkdirSync(rendererDir)
  fs.writeFileSync(
    path.join(rendererDir, 'index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'" /><div id="root"></div>`
  )
  fs.writeFileSync(path.join(rendererDir, 'app.js'), 'console.log(1)')
  auth = new Auth(dir)
  server = http.createServer(createHttpHandler({ auth, rendererDir }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function setupAndLogin(): Promise<string> {
  const tok = auth.setupToken()
  const res = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${tok}&password=hunter22-secret`,
    redirect: 'manual'
  })
  expect(res.status).toBe(303)
  const cookie = res.headers.get('set-cookie')!
  expect(cookie).toContain(`${SESSION_COOKIE}=`)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  return cookie.split(';')[0]
}

describe('http layer', () => {
  it('unauthenticated: html → /login redirect, api → 401; /login redirects to /setup when unconfigured', async () => {
    const r1 = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(r1.status).toBe(302)
    const r2 = await fetch(`${base}/anything.json`, { redirect: 'manual' })
    expect(r2.status).toBe(401)
    const r3 = await fetch(`${base}/login`, { redirect: 'manual' })
    expect(r3.status).toBe(302)
    expect(r3.headers.get('location')).toContain('/setup')
  })

  it('setup with the one-time token creates the password and a session; token single-use', async () => {
    const cookie = await setupAndLogin()
    const home = await fetch(`${base}/`, { headers: { cookie } })
    expect(home.status).toBe(200)
    const again = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=whatever&password=xxxxxxxxx`,
      redirect: 'manual'
    })
    expect(again.status).toBe(403)
  })

  it('login: wrong password → redirect with error; right → cookie; rate limit → 429', async () => {
    await setupAndLogin()
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
        redirect: 'manual'
      })
      expect([303, 429]).toContain(bad.status)
    }
    const locked = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter22-secret',
      redirect: 'manual'
    })
    expect(locked.status).toBe(429)
  })

  it('serves static with CSP rewrite on index.html and blocks traversal', async () => {
    const cookie = await setupAndLogin()
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text()
    expect(html).toContain(`connect-src 'self' ws: wss:`)
    const js = await fetch(`${base}/app.js`, { headers: { cookie } })
    expect(js.headers.get('content-type')).toContain('javascript')
    const evil = await fetch(`${base}/..%2f..%2fauth.json`, { headers: { cookie } })
    expect([400, 401, 404]).toContain(evil.status)
    expect(await evil.text()).not.toContain('salt')
  })

  it('warns (and still 200s) when index.html lacks the CSP rewrite marker', async () => {
    const cookie = await setupAndLogin()
    fs.writeFileSync(
      path.join(rendererDir, 'index.html'),
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'" /><div id="root"></div>`
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await fetch(`${base}/`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).not.toContain('connect-src')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('CSP')
      expect(warn.mock.calls[0][0]).toContain('WebSocket')
    } finally {
      warn.mockRestore()
    }
  })

  it('sessionTokenFromCookie parses the session out of a multi-cookie header', () => {
    expect(sessionTokenFromCookie(`a=b; ${SESSION_COOKIE}=tok123; c=d`)).toBe('tok123')
    expect(sessionTokenFromCookie(undefined)).toBeUndefined()
  })
})

describe('http layer with proxy header trust', () => {
  const HDR = 'Cf-Access-Authenticated-User-Email'

  function trustedServer(netsSpec: string): Promise<{ srv: http.Server; url: string }> {
    const srv = http.createServer(
      createHttpHandler({
        auth,
        rendererDir,
        trustProxy: { header: HDR, nets: parseTrustedNets(netsSpec) }
      })
    )
    return new Promise((r) =>
      srv.listen(0, '127.0.0.1', () =>
        r({ srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` })
      )
    )
  }

  it('trusted peer + header: serves the app with no cookie; /login and /setup redirect home', async () => {
    const { srv, url } = await trustedServer('127.0.0.0/8')
    try {
      const home = await fetch(`${url}/`, { headers: { [HDR]: 'dev@corp.com' } })
      expect(home.status).toBe(200)
      const login = await fetch(`${url}/login`, {
        headers: { [HDR]: 'dev@corp.com' },
        redirect: 'manual'
      })
      expect(login.status).toBe(302)
      expect(login.headers.get('location')).toBe('/')
      const setup = await fetch(`${url}/setup`, {
        headers: { [HDR]: 'dev@corp.com' },
        redirect: 'manual'
      })
      expect(setup.status).toBe(302)
      expect(setup.headers.get('location')).toBe('/')
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  it('missing/empty header, or a peer outside the nets, falls through to normal auth', async () => {
    const { srv, url } = await trustedServer('127.0.0.0/8')
    const { srv: srvFar, url: urlFar } = await trustedServer('10.0.0.0/8')
    try {
      expect((await fetch(`${url}/x.json`, { redirect: 'manual' })).status).toBe(401)
      expect(
        (await fetch(`${url}/x.json`, { headers: { [HDR]: '  ' }, redirect: 'manual' })).status
      ).toBe(401)
      // Loopback peer, but the trusted nets exclude loopback → the header means nothing.
      expect(
        (await fetch(`${urlFar}/x.json`, { headers: { [HDR]: 'dev@corp.com' }, redirect: 'manual' }))
          .status
      ).toBe(401)
      // Password/cookie auth still works beside proxy trust.
      const cookie = await setupAndLogin()
      const viaCookie = await fetch(`${urlFar}/`, { headers: { cookie } })
      expect(viaCookie.status).toBe(200)
    } finally {
      await new Promise((r) => srv.close(r))
      await new Promise((r) => srvFar.close(r))
    }
  })
})
