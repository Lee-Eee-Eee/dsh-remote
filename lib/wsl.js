/**
 * WSL discovery on the host machine (`wsl.exe -l -v`).
 *
 * Windows is the only supported host for this connector. The listing is
 * UTF-16LE; a launch failure (WSL not installed, service stopped, a sandbox
 * that denies the distro VHDX) is reported as an `error` string rather than an
 * exception so the panel can show the actionable hint.
 * @module dsh-remote/wsl
 */

import { execFile } from 'node:child_process'

/**
 * Decode `wsl.exe` output. The listing is UTF-16LE **without** a BOM on Windows
 * builds that write it to a pipe, so the NUL-byte pattern is the real signal;
 * a UTF-8 listing (some builds, and `wsl --version`) is the fallback.
 * @param {Buffer} buffer - raw stdout.
 * @returns {string} decoded text.
 */
export function decodeWslOutput(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  let oddZeros = 0
  const sample = Math.min(buffer.length, 400)
  for (let index = 1; index < sample; index += 2) {
    if (buffer[index] === 0) oddZeros += 1
  }
  if (sample >= 4 && oddZeros >= Math.floor(sample / 4)) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '')
  }
  return buffer.toString('utf8')
}

/**
 * Parse `wsl.exe -l -v` output.
 * @param {string} text - decoded listing.
 * @returns {Array<{name: string, state: string, version: number, isDefault: boolean}>} distros.
 */
export function parseWslList(text) {
  const lines = text.split(/\r?\n/)
  const distros = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^(NAME|名称)\s/i.test(trimmed)) continue
    const isDefault = trimmed.startsWith('*')
    const body = isDefault ? trimmed.slice(1).trim() : trimmed
    const match = /^(\S.*?)\s{2,}(\S+)\s+(\d+)$/.exec(body)
    if (match === null) continue
    distros.push({
      name: match[1].trim(),
      state: match[2].trim(),
      version: Number.parseInt(match[3], 10),
      isDefault,
    })
  }
  return distros
}

/** Run `wsl.exe` with a timeout, resolving to a raw buffer. */
function runWsl(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('wsl.exe', args, { timeout: timeoutMs, encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0) })
    })
  })
}

/**
 * List WSL distributions available on this machine.
 * @returns {Promise<{available: boolean, distros: Array<object>, error?: string}>}
 */
export async function discoverWsl() {
  if (process.platform !== 'win32') {
    return { available: false, distros: [], error: 'WSL targets are only available on Windows hosts' }
  }
  const { error, stdout, stderr } = await runWsl(['-l', '-v'], 15000)
  const text = decodeWslOutput(stdout)
  const distros = parseWslList(text)
  if (distros.length > 0) return { available: true, distros }
  if (error !== null && error !== undefined) {
    const detail = decodeWslOutput(stderr).replace(/\0/g, '').trim() || error.message
    return {
      available: false,
      distros: [],
      error: simplifyWslError(detail),
    }
  }
  return { available: false, distros: [], error: 'no WSL distribution installed' }
}

/** Turn a raw `wsl.exe` failure into one actionable sentence. */
function simplifyWslError(detail) {
  if (/E_ACCESSDENIED|拒绝访问/i.test(detail)) {
    return 'WSL refused access to the distribution (Wsl/E_ACCESSDENIED): start it once from a terminal (`wsl -d <distro>`), or check the Windows sandbox/permissions of the distro disk.'
  }
  if (/WslService|service|服务/i.test(detail)) {
    return 'the WSL service is not running: open a terminal and run `wsl --status`, then retry.'
  }
  return detail.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ')
}
