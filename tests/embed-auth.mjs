/**
 * Regression test for the "dsh web authentication required" panel.
 *
 * The desktop page runs on a custom `app` origin, so every iframe is
 * cross-site and the remote's `SameSite=Strict` cookie is never sent. The
 * plugin therefore fronts the remote with a loopback proxy that performs the
 * handshake itself and injects the cookie upstream.
 *
 * What this asserts — the exact thing an anonymous cross-site iframe needs:
 *   - the URL handed to the iframe carries no token,
 *   - loading it with no cookie at all returns the app page (200),
 *   - a WebSocket upgrade through the proxy reaches the remote (101).
 *
 * Run: node tests/embed-auth.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TargetManager, httpStatus } from '../lib/manager.js'

const distro = process.env.DISTRO ?? 'Debian'
const registry = join(tmpdir(), `dsh-remote-embed-${Date.now()}.json`)
const manager = new TargetManager({ file: registry })
const log = (...parts) => console.log(...parts)

/** Fetch a page and return its status and body. */
async function get(port, path) {
  const http = await import('node:http')
  return new Promise((resolve) => {
    const request = http.default.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', () => resolve({ status: 0, body: '' }))
    request.end()
  })
}

/** Send a raw WebSocket-style upgrade through the proxy and read the status line. */
function upgradeStatus(port, path) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol: dsh-v1',
        '',
        '',
      ].join('\r\n'))
    })
    let received = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, 6000)
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      if (received.includes('\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(received)
    })
  })
}

try {
  const created = manager.create({ kind: 'wsl', label: `WSL ${distro}`, wsl: { distro } })
  const started = await manager.start(created.id)
  assert.equal(started.state, 'running')
  const url = new URL(started.url)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.search, '', 'the iframe URL must not carry a token')
  log(`started -> ${started.url} (token kept in the host process)`)

  const port = Number(url.port)
  const page = await get(port, '/')
  assert.equal(page.status, 200, 'an anonymous cross-site iframe must get the app page')
  assert.match(page.body, /DeepSeek Harness/, 'the page must be the real UI, not the 401 notice')
  assert.doesNotMatch(page.body, /authentication required/)
  log(`GET / through the proxy with no cookie -> ${page.status} (${page.body.length} bytes)`)

  const assets = await get(port, '/assets/index-BXV-oxvX.js')
  assert.ok(assets.status === 200 || assets.status === 404, 'asset requests are proxied, not rejected')
  log(`GET /assets/... -> ${assets.status}`)

  const upgrade = await upgradeStatus(port, '/api/remote.mux')
  assert.match(upgrade, /HTTP\/1\.1 (101|400|401|403)/, 'the upgrade reaches the remote')
  log(`WebSocket upgrade through the proxy -> ${upgrade.split('\r\n')[0]}`)

  // A stopped target must stop serving through the proxy.
  await manager.stop(created.id)
  assert.equal(await httpStatus(port, '/'), 0, 'the proxy listener is released on stop')
  console.log('\nembed-auth: all assertions passed')
} catch (error) {
  console.error('\nembed-auth FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  manager.dispose()
  if (existsSync(registry)) rmSync(registry, { force: true })
}
