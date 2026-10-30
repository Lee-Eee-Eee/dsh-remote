/**
 * Authentication-injecting reverse proxy for the embedded remote UI.
 *
 * Why this exists: a DSH auth cookie is `SameSite=Strict`, and the desktop app
 * serves its own page from a custom `app` origin. An iframe pointing at the
 * remote is therefore *cross-site*, so the browser never sends that cookie —
 * the panel would land on "dsh web authentication required" no matter which
 * loopback spelling the remote advertises (`127.0.0.1`, `localhost`, `app`).
 *
 * The way out is to stop asking the browser to hold the cookie at all:
 *
 *   1. the host process performs the `/ ?token=…` handshake once and keeps the
 *      resulting cookie in memory;
 *   2. the iframe talks to a loopback listener on this machine that forwards
 *      every request (and every WebSocket upgrade) to the remote, adding the
 *      cookie and rewriting `Host` to the authority the remote was bound to.
 *
 * The browser sees an ordinary HTTP server, the remote sees first-party
 * requests, and no credential ever reaches the page: the URL handed to the
 * iframe contains no token.
 * @module dsh-remote/frame-proxy
 */

import http from 'node:http'
import net from 'node:net'

/** Header names that must not survive the hop. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * Flatten outgoing headers: drop hop-by-hop entries, keep arrays as-is.
 * @param {import('node:http').IncomingHttpHeaders} headers - client headers.
 * @returns {Record<string, string | string[]>} forwardable headers.
 */
function forwardableHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    result[name] = value
  }
  return result
}

/** The proxy. */
export class FrameProxy {
  /**
   * @param {{targetPort: number, remotePort: number, token: string, host?: string}} options - upstream and credential.
   */
  constructor({ targetPort, remotePort, token, host = '127.0.0.1' }) {
    this.targetPort = targetPort
    this.remotePort = remotePort
    this.token = token
    this.host = host
    this.cookie = ''
    this.server = undefined
    this.port = undefined
    this.closed = false
  }

  /** The URL the iframe should load (no token, no cookie dependency). */
  get url() {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}/`
  }

  /**
   * Perform the token handshake and start listening.
   * @returns {Promise<string>} the iframe URL.
   */
  async start() {
    await this.refreshAuth()
    this.server = http.createServer((req, res) => { this.handle(req, res) })
    this.server.on('upgrade', (req, socket, head) => { this.handleUpgrade(req, socket, head) })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address !== null ? address.port : undefined
    return this.url
  }

  /**
   * Run the `/?token=…` exchange and store the issued cookie.
   * @returns {Promise<boolean>} whether a cookie was captured.
   */
  async refreshAuth() {
    const result = await new Promise((resolve) => {
      const request = http.request({
        host: '127.0.0.1',
        port: this.targetPort,
        path: `/?token=${this.token}`,
        method: 'GET',
        headers: { host: `${this.host}:${this.remotePort}`, accept: 'text/html' },
        timeout: 10000,
      }, (response) => {
        response.resume()
        const raw = response.headers['set-cookie']
        const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        resolve({ status: response.statusCode ?? 0, cookies: list })
      })
      request.on('timeout', () => {
        request.destroy()
        resolve({ status: 0, cookies: [] })
      })
      request.on('error', () => resolve({ status: 0, cookies: [] }))
      request.end()
    })
    const cookie = result.cookies.map(line => line.split(';')[0]).join('; ')
    if (cookie !== '') this.cookie = cookie
    return cookie !== ''
  }

  /**
   * Forward one HTTP request, injecting authentication.
   * @param {import('node:http').IncomingMessage} req - client request.
   * @param {import('node:http').ServerResponse} res - client response.
   * @param {boolean} [retried] - internal: a re-handshake already happened.
   */
  handle(req, res, retried = false) {
    const headers = forwardableHeaders(req.headers)
    headers.host = `${this.host}:${this.remotePort}`
    if (this.cookie !== '') headers.cookie = this.cookie
    const upstream = http.request({
      host: '127.0.0.1',
      port: this.targetPort,
      method: req.method,
      path: req.url,
      headers,
    }, (response) => {
      if (response.statusCode === 401 && !retried) {
        response.resume()
        this.refreshAuth().then(() => { this.handle(req, res, true) }).catch(() => {
          if (!res.headersSent) res.writeHead(502).end('auth refresh failed')
        })
        return
      }
      const outHeaders = forwardableHeaders(response.headers)
      // Never let the remote's cookie land in the browser: it would be scoped
      // to this proxy origin and blocked anyway, and the host process owns it.
      delete outHeaders['set-cookie']
      res.writeHead(response.statusCode ?? 502, outHeaders)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`remote unreachable: ${error.message}`)
    })
    req.pipe(upstream)
  }

  /**
   * Forward one WebSocket upgrade as raw bytes.
   * @param {import('node:http').IncomingMessage} req - upgrade request.
   * @param {import('node:stream').Duplex} socket - client socket.
   * @param {Buffer} head - bytes already read.
   */
  handleUpgrade(req, socket, head) {
    const headers = forwardableHeaders(req.headers)
    headers.host = `${this.host}:${this.remotePort}`
    if (this.cookie !== '') headers.cookie = this.cookie
    // `connection` and `upgrade` are hop-by-hop and were dropped above; the
    // upstream still needs them, or it answers a plain GET instead of switching.
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const upstream = net.connect(this.targetPort, '127.0.0.1', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`)
        } else {
          lines.push(`${name}: ${value}`)
        }
      }
      lines.push('', '')
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  }

  /** Close the listener. */
  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.server?.close()
    } catch {
      /* already closed */
    }
  }
}
