/**
 * Route-level checks for the host half. Mounts the plugin against a fake
 * webserver, then drives the handlers with synthetic requests: this proves the
 * loopback fence, method dispatch, discovery payload, target CRUD and the
 * configuration preview (which must never contain a secret value).
 *
 * Run: node tests/routes.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-routes-'))
process.env.DSH_HOME = dir

const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  webServer: { register(route) { routes.push(route); return () => {} }, registerUpgrade() { return () => {} } },
}

apply(ctx)
await new Promise(resolve => setTimeout(resolve, 1500))

const byPath = new Map(routes.map(route => [route.path, route]))
assert.equal(byPath.size, routes.length, 'route paths are unique')
assert.ok(byPath.has('/api/dsh-remote/targets'))
assert.ok(byPath.has('/api/dsh-remote/bootstrap'))
assert.ok(byPath.has('/api/dsh-remote/local-config'))

/** Minimal ServerResponse stand-in. */
function fakeResponse() {
  const state = { status: 0, body: '', headers: {} }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk)
    },
    write(chunk) {
      state.body += String(chunk)
      return true
    },
    on() {},
    get writableEnded() { return false },
  }
}

/** Minimal IncomingMessage stand-in (loopback by default). */
function fakeRequest({ method = 'GET', url = '/', body, remoteAddress = '127.0.0.1', headers = {} }) {
  const base = {
    method,
    url,
    headers: { host: '127.0.0.1:1615', ...headers },
    socket: { remoteAddress },
  }
  return {
    ...base,
    destroy() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

async function call(path, options) {
  const route = byPath.get(path)
  assert.ok(route !== undefined, `route ${path} exists`)
  const response = fakeResponse()
  await route.handler(fakeRequest(options ?? {}), response)
  return response.state
}

// --- fence ----------------------------------------------------------------
const forbidden = await call('/api/dsh-remote/targets', { remoteAddress: '192.168.1.9' })
assert.equal(forbidden.status, 403, 'non-loopback socket is refused')
const proxied = await call('/api/dsh-remote/targets', { headers: { 'x-forwarded-for': '1.2.3.4' } })
assert.equal(proxied.status, 403, 'forwarded request is refused')
const crossSite = await call('/api/dsh-remote/targets', { headers: { 'sec-fetch-site': 'cross-site' } })
assert.equal(crossSite.status, 403, 'cross-site request is refused')

// --- method dispatch ------------------------------------------------------
const wrongMethod = await call('/api/dsh-remote/targets', { method: 'PUT' })
assert.equal(wrongMethod.status, 405)

// --- discovery ------------------------------------------------------------
const listed = await call('/api/dsh-remote/targets')
assert.equal(listed.status, 200)
const list = JSON.parse(listed.body)
assert.ok(Array.isArray(list.targets))
assert.ok(Array.isArray(list.discovery.ssh))
assert.ok(Array.isArray(list.discovery.wsl))
console.log(`discovery: ${list.discovery.ssh.length} ssh hosts, ${list.discovery.wsl.length} WSL distros`)

// --- create ---------------------------------------------------------------
const created = await call('/api/dsh-remote/targets', {
  method: 'POST',
  body: { kind: 'wsl', label: 'WSL test', wsl: { distro: 'Debian' } },
})
assert.equal(created.status, 201)
const createdTarget = JSON.parse(created.body).target
assert.equal(createdTarget.kind, 'wsl')
assert.equal(createdTarget.state, 'idle')

const invalid = await call('/api/dsh-remote/targets', { method: 'POST', body: { kind: 'ssh', label: 'nope' } })
assert.equal(invalid.status, 400, 'a target without alias or host is rejected')

// --- config preview never leaks a value -----------------------------------
const configBody = await call('/api/dsh-remote/local-config', { url: `/api/dsh-remote/local-config?id=${createdTarget.id}` })
assert.equal(configBody.status, 200)
const preview = JSON.parse(configBody.body).config
assert.ok(Array.isArray(preview.items))
const text = configBody.body
assert.doesNotMatch(text, /apiKeyEnv:\s*\S/, 'no provider block text is returned')
assert.doesNotMatch(text, /"secret":"/, 'no credential record is returned')
console.log(`config items: ${preview.items.map(item => `${item.id}=${item.present}`).join(', ')}`)

// --- status / patch / delete ---------------------------------------------
const status = await call('/api/dsh-remote/status', { url: `/api/dsh-remote/status?id=${createdTarget.id}` })
assert.equal(status.status, 200)
assert.equal(JSON.parse(status.body).target.id, createdTarget.id)

const patched = await call('/api/dsh-remote/targets', {
  method: 'PATCH',
  url: `/api/dsh-remote/targets?id=${createdTarget.id}`,
  body: { label: 'renamed' },
})
assert.equal(patched.status, 200)
assert.equal(JSON.parse(patched.body).target.label, 'renamed')

const removed = await call('/api/dsh-remote/targets', { method: 'DELETE', url: `/api/dsh-remote/targets?id=${createdTarget.id}` })
assert.equal(removed.status, 200)
const after = JSON.parse((await call('/api/dsh-remote/targets')).body)
assert.equal(after.targets.length, 0)

rmSync(dir, { recursive: true, force: true })
console.log('routes: all assertions passed')
process.exit(0)
