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
import http from 'node:http'
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
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', () => resolve({ status: 0, body: '' }))
    request.end()
  })
}

/**
 * Send a raw WebSocket-style upgrade through the proxy, with the browser
 * markers a cross-site iframe actually sends, and report the status line plus
 * how many bytes the upstream pushed within `holdMs`.
 * @param {number} port - proxy port.
 * @param {string} path - upgrade path.
 * @param {string[]} headers - extra request header lines.
 * @param {number} [holdMs] - how long to keep reading.
 * @returns {Promise<{statusLine: string, bytes: number}>} outcome.
 */
function upgradeStatus(port, path, headers = [], holdMs = 3000) {
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
        ...headers,
        '',
        '',
      ].join('\r\n'))
    })
    let received = Buffer.alloc(0)
    let statusLine = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ statusLine, bytes: received.length })
    }, holdMs)
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (statusLine === '') {
        const text = received.toString('utf8')
        const index = text.indexOf('\r\n')
        if (index >= 0) statusLine = text.slice(0, index)
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve({ statusLine: statusLine || 'SOCKET ERROR', bytes: received.length })
    })
  })
}

/** POST one JSON body through the proxy with the browser's cross-site markers. */
function postJson(port, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', () => resolve(0))
    request.end(payload)
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

  // The desktop page is on a custom `app` origin, so the iframe's requests
  // carry cross-site markers. The remote's /api fence rejects a foreign Origin
  // and `Sec-Fetch-Site: cross-site`; the proxy must present them as
  // same-origin, or the mux never connects and the UI stays on "reconnecting".
  const browserHeaders = [
    `Origin: ${url.origin}`,
    'Sec-Fetch-Site: cross-site',
    'Sec-Fetch-Mode: websocket',
    'Sec-Fetch-Dest: empty',
  ]
  const upgrade = await upgradeStatus(port, '/api/remote.mux', browserHeaders)
  assert.equal(upgrade.statusLine, 'HTTP/1.1 101 Switching Protocols', 'the mux upgrade must not be fenced out')
  assert.ok(upgrade.bytes > 0, 'the mux must push frames, not hang half-open')
  log(`WebSocket upgrade with browser markers -> ${upgrade.statusLine} (${upgrade.bytes} bytes)`)

  const appOrigin = await upgradeStatus(port, '/api/remote.mux', ['Origin: app://dsh', 'Sec-Fetch-Site: cross-site'])
  assert.equal(appOrigin.statusLine, 'HTTP/1.1 101 Switching Protocols', 'a custom app origin must work too')
  log(`WebSocket upgrade with app:// origin -> ${appOrigin.statusLine}`)

  const apiPost = await postJson(port, '/api/settings/describe', {})
  assert.notEqual(apiPost, 403, 'API calls with a browser Origin must pass the fence')
  log(`POST /api/settings/describe with Origin -> ${apiPost} (not 403)`)

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
