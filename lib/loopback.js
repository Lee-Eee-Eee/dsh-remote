/**
 * Loopback trust fence for the /api/dsh-remote route family: the socket
 * address, the Host header, and the browser same-origin markers. These routes
 * start remote processes and open network tunnels, so a LAN-exposed dsh web
 * deployment must never serve them.
 *
 * Semantics mirror `@linxin666/dsh-ssh`'s shared fence: RFC 5735 IPv4 127/8,
 * `::1`, IPv4-mapped `::ffff:127/8`, localhost hostnames, plus `sec-fetch-site`
 * and `Origin`; any forwarding header means a proxy stood in between and the
 * request is refused outright.
 * @module dsh-remote/loopback
 */

/** IPv4 127/8 predicate. */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range. */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Whether a forwarding header marks a proxied request. */
export function isProxiedRequest(request) {
  return request.headers['cf-connecting-ip'] !== undefined
    || request.headers['x-forwarded-for'] !== undefined
}

/**
 * Request-level trust fence.
 * @param {import('node:http').IncomingMessage} request - node HTTP request.
 * @returns {boolean} true when the request provably came from this machine.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
