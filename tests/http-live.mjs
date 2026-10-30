/**
 * Live HTTP integration check: mounts the real route handlers on a loopback
 * http server and drives them exactly as the panel does — including the NDJSON
 * install stream and the iframe URL's 303.
 *
 * Run: node tests/http-live.mjs
 * Requires a reachable WSL distribution (`wsl.exe -l -v`) or set DISTRO.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TargetManager } from '../lib/manager.js'
import { makeRoutes } from '../lib/routes.js'

const distro = process.env.DISTRO ?? 'Debian'
const homeDir = mkdtempSync(join(tmpdir(), 'dsh-remote-http-'))
// The registry lives in a temp file, but DSH_HOME stays the real one: that is
// what makes the configuration preview and the port step exercise real data.
const manager = new TargetManager({ file: join(homeDir, 'dsh-remote.json') })
const server = http.createServer((req, res) => {
  const route = routes.find(item => item.path === req.url.split('?')[0])
  if (route === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
  })
})
const routes = makeRoutes({ manager })

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}/api/dsh-remote`
const log = (...parts) => console.log(...parts)

/** JSON request helper. */
async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

let createdId
try {
  // --- list ---------------------------------------------------------------
  const list = await json('/targets?refresh=1')
  assert.equal(list.status, 200)
  log(`GET /targets -> ${list.status}, discovery: ${list.body.discovery.ssh.length} ssh, ${list.body.discovery.wsl.length} wsl`)

  // --- create -------------------------------------------------------------
  const created = await json('/targets', { method: 'POST', body: { kind: 'wsl', label: `WSL ${distro}`, wsl: { distro } } })
  assert.equal(created.status, 201)
  createdId = created.body.target.id
  log(`POST /targets -> ${created.status} (${createdId})`)

  // --- probe --------------------------------------------------------------
  const probe = await json(`/probe?id=${createdId}`, { method: 'POST' })
  assert.equal(probe.status, 200)
  log(`POST /probe -> ${probe.status}, status=${probe.body.target.caps.status}, node=${probe.body.target.caps.nodeVersion}, dsh=${probe.body.target.caps.dshVersion}`)

  // --- config preview -----------------------------------------------------
  const config = await json(`/local-config?id=${createdId}`)
  assert.equal(config.status, 200)
  assert.equal(typeof config.body.config.items, 'object')
  const leaked = JSON.stringify(config.body)
  assert.doesNotMatch(leaked, /apiKeyEnv/)
  log(`GET /local-config -> ${config.status}, items=${config.body.config.items.filter(item => item.present).map(item => item.id).join(',')}`)

  // --- config sync (idempotent; already ported by the e2e) ----------------
  const sync = await json(`/sync-config?id=${createdId}`, { method: 'POST', body: { items: ['providers', 'default-model', 'api-keys'] } })
  assert.equal(sync.status, 200)
  log(`POST /sync-config -> ${sync.status}, wrote=${sync.body.wrote.length} file(s), restarted=${sync.body.restarted}`)

  // --- NDJSON bootstrap (everything already installed: expect done) -------
  const stream = await fetch(`${base}/bootstrap?id=${createdId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skip: ['node', 'dsh'] }),
  })
  assert.equal(stream.status, 200)
  const frames = (await stream.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(frames.some(frame => frame.type === 'plan' || frame.type === 'done' || frame.type === 'error'))
  log(`POST /bootstrap -> ${stream.status}, frames=${frames.length} (${frames.map(frame => frame.type ?? frame.phase).join(',')})`)

  // --- start / status / iframe -------------------------------------------
  const started = await json(`/start?id=${createdId}`, { method: 'POST' })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const url = started.body.target.url
  // The iframe gets the auth-injecting proxy, never the remote (and never a token).
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  log(`POST /start -> ${started.status}, state=${started.body.target.state}`)

  const embeddedPort = Number(new URL(url).port)
  const iframe = await new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: embeddedPort, path: '/', headers: { host: `127.0.0.1:${embeddedPort}` } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', () => resolve(0))
    request.end()
  })
  assert.equal(iframe, 200, 'the embedded URL must serve the app page without any cookie')
  log(`GET iframe url -> ${iframe} (anonymous, no cookie needed)`)

  const status = await json(`/status?id=${createdId}`)
  assert.equal(status.status, 200)
  assert.equal(status.body.target.state, 'running')
  log(`GET /status -> ${status.status}, state=${status.body.target.state}, version=${status.body.target.version}`)

  // --- stop ---------------------------------------------------------------
  const stopped = await json(`/stop?id=${createdId}`, { method: 'POST' })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.target.state, 'idle')
  log(`POST /stop -> ${stopped.status}, state=${stopped.body.target.state}`)

  await json(`/targets?id=${createdId}`, { method: 'DELETE' })
  console.log('\nhttp-live: all assertions passed')
} catch (error) {
  console.error('\nhttp-live FAILED:', error instanceof Error ? error.message : error)
  if (createdId !== undefined) {
    const detail = await json(`/status?id=${createdId}`).catch(() => undefined)
    console.error('last status:', JSON.stringify(detail?.body?.target?.lastError ?? detail?.body))
  }
  process.exitCode = 1
} finally {
  server.close()
  manager.dispose()
  rmSync(homeDir, { recursive: true, force: true })
}
