/**
 * Remote environment probe: one bash script that reports the facts the panel
 * needs (OS, arch, Node, dsh, tmux, download tools, free disk) as `KEY=value`
 * lines, plus the classifier that turns them into a plan decision.
 * @module dsh-remote/probe
 */

import { execFile } from 'node:child_process'

/**
 * Probe script; every line is printf-formatted so values never break parsing.
 * Written as an explicit line list because the bash parameter expansions
 * (`${VAR:-default}`) would otherwise collide with JavaScript interpolation.
 * @type {string}
 */
export const PROBE_SCRIPT = [
  'emit() { printf \'DR_%s=%s\\n\' "$1" "$2"; }',
  'emit OS "$(uname -s 2>/dev/null)"',
  'emit ARCH "$(uname -m 2>/dev/null)"',
  'emit KERNEL "$(uname -r 2>/dev/null)"',
  'emit HOME "$HOME"',
  'emit USER "$(id -un 2>/dev/null)"',
  'emit SHELL_BIN "$SHELL"',
  'if [ -r /etc/os-release ]; then DISTRO=$(. /etc/os-release 2>/dev/null; printf \'%s\' "$PRETTY_NAME"); emit DISTRO "$DISTRO"; fi',
  'NODE_BIN=$(command -v node 2>/dev/null)',
  'emit NODE_BIN "$NODE_BIN"',
  'if [ -n "$NODE_BIN" ]; then emit NODE_VERSION "$(node -v 2>/dev/null)"; fi',
  'emit NPM_BIN "$(command -v npm 2>/dev/null)"',
  'DSH_BIN=$(command -v dsh 2>/dev/null)',
  'emit DSH_BIN "$DSH_BIN"',
  'if [ -n "$DSH_BIN" ]; then emit DSH_VERSION "$(dsh --version 2>/dev/null | head -n 1)"; fi',
  'emit TMUX_BIN "$(command -v tmux 2>/dev/null)"',
  'emit CURL_BIN "$(command -v curl 2>/dev/null)"',
  'emit WGET_BIN "$(command -v wget 2>/dev/null)"',
  'emit TAR_BIN "$(command -v tar 2>/dev/null)"',
  'emit SETSID_BIN "$(command -v setsid 2>/dev/null)"',
  'emit NPROC "$(nproc 2>/dev/null || echo 0)"',
  'emit MEM_KB "$(awk \'/MemTotal/{print $2}\' /proc/meminfo 2>/dev/null || echo 0)"',
  'emit DISK_AVAIL_KB "$(df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4}\')"',
  'emit DSH_HOME_OK "$(test -d "$HOME/.dsh" && printf 1 || printf 0)"',
  'emit PROFILE_PATCH "$(test -f "$HOME/.dsh/profiles/web/cordis.patch.yml" && printf 1 || printf 0)"',
  'emit PROFILE_PROVIDERS "$(grep -c \'apiKeyEnv\' "$HOME/.dsh/profiles/web/cordis.patch.yml" 2>/dev/null || printf 0)"',
  'emit PROBE_END 1',
].join('\n')

/** Minimum Node the remote side needs (matches the plugin's own engines). */
export const MIN_NODE = [22, 19, 0]

/**
 * Compare two dotted versions.
 * @param {number[]} a - left.
 * @param {number[]} b - right.
 * @returns {number} negative, zero, or positive.
 */
function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

/**
 * Parse a `vX.Y.Z` string.
 * @param {string | undefined} value - version text.
 * @returns {number[]} parsed numeric parts, empty when unparseable.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return []
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (match === null) return []
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether a Node version satisfies `^22.19.0 || >=24.0.0`.
 * @param {string | undefined} version - reported `node -v`.
 * @returns {boolean} true when the remote Node is new enough.
 */
export function isSupportedNode(version) {
  const parts = parseVersion(version)
  if (parts.length === 0) return false
  if (parts[0] === 22) return compareVersions(parts, MIN_NODE) >= 0
  return parts[0] >= 24
}

/**
 * Parse probe output into a capability record.
 * @param {string} stdout - probe stdout.
 * @returns {{ok: boolean, fields: Record<string, string>}} parsed fields plus whether the terminator arrived.
 */
export function parseProbeOutput(stdout) {
  const fields = {}
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^DR_([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match === null) continue
    fields[match[1]] = match[2]
  }
  return { ok: fields.PROBE_END === '1', fields }
}

/**
 * Classify a parsed probe into the state the UI shows.
 * @param {Record<string, string>} fields - parsed probe fields.
 * @returns {{status: 'ready'|'need-dsh'|'need-node'|'unsupported', reasons: string[], nodeOk: boolean, dshOk: boolean, canBootstrap: boolean}}
 */
export function classifyProbe(fields) {
  const reasons = []
  const os = (fields.OS ?? '').toLowerCase()
  const arch = fields.ARCH ?? ''
  if (os !== 'linux') {
    reasons.push(`远程系统是 ${fields.OS ?? 'unknown'}，dsh-remote 只支持 Linux 目标（{x86_64, aarch64}）。`)
    return { status: 'unsupported', reasons, nodeOk: false, dshOk: false, canBootstrap: false }
  }
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(arch)) {
    reasons.push(`架构 ${arch || 'unknown'} 不在 Node 官方 linux 发行版范围内。`)
    return { status: 'unsupported', reasons, nodeOk: false, dshOk: false, canBootstrap: false }
  }
  const nodeOk = isSupportedNode(fields.NODE_VERSION)
  const dshOk = (fields.DSH_BIN ?? '') !== ''
  if (!nodeOk) {
    reasons.push(fields.NODE_VERSION === undefined
      ? '没有找到 node。'
      : `Node ${fields.NODE_VERSION} 低于要求（^22.19.0 || >=24）。`)
  }
  if (!dshOk) reasons.push('没有找到 dsh 命令。')
  const canDownload = (fields.CURL_BIN ?? '') !== '' || (fields.WGET_BIN ?? '') !== ''
  if (!nodeOk && !canDownload) reasons.push('远程既没有 curl 也没有 wget，无法下载 Node。')
  if (!nodeOk && (fields.TAR_BIN ?? '') === '') reasons.push('远程没有 tar，无法解包 Node。')
  const canBootstrap = nodeOk && dshOk
    ? true
    : canDownload && (fields.TAR_BIN ?? '') !== ''
  if (nodeOk && dshOk) return { status: 'ready', reasons, nodeOk, dshOk, canBootstrap }
  if (!nodeOk) return { status: 'need-node', reasons, nodeOk, dshOk, canBootstrap }
  return { status: 'need-dsh', reasons, nodeOk, dshOk, canBootstrap }
}

/**
 * Public, display-safe capability table derived from the probe.
 * @param {Record<string, string>} fields - parsed probe fields.
 * @returns {Record<string, string | number | undefined>} capability summary.
 */
export function summarizeCaps(fields) {
  const diskKb = Number.parseInt(fields.DISK_AVAIL_KB ?? '', 10)
  const providerRows = Number.parseInt(fields.PROFILE_PROVIDERS ?? '', 10) || 0
  return {
    os: fields.OS,
    arch: fields.ARCH,
    distro: fields.DISTRO,
    kernel: fields.KERNEL,
    user: fields.USER,
    home: fields.HOME,
    nodeVersion: fields.NODE_VERSION,
    nodePath: fields.NODE_BIN,
    dshVersion: fields.DSH_VERSION,
    dshPath: fields.DSH_BIN,
    npmPath: fields.NPM_BIN,
    tmuxPath: fields.TMUX_BIN,
    curlPath: fields.CURL_BIN,
    wgetPath: fields.WGET_BIN,
    hasTar: (fields.TAR_BIN ?? '') !== '',
    setsidPath: fields.SETSID_BIN,
    cpus: Number.parseInt(fields.NPROC ?? '', 10) || undefined,
    memMB: Number.parseInt(fields.MEM_KB ?? '', 10) ? Math.round(Number(fields.MEM_KB) / 1024) : undefined,
    diskFreeGB: Number.isFinite(diskKb) ? Math.round((diskKb / 1024 / 1024) * 10) / 10 : undefined,
    hasDshHome: fields.DSH_HOME_OK === '1',
    hasProfilePatch: fields.PROFILE_PATCH === '1',
    providerCount: providerRows,
    needsConfig: providerRows === 0,
  }
}

/**
 * Best-effort host-key fingerprint of an SSH destination, read from the local
 * `known_hosts` after a successful connection. Informational only: the panel
 * shows it so the user can compare against the server's own fingerprint.
 * @param {string} destination - ssh alias or `[user@]host`.
 * @returns {Promise<string | undefined>} fingerprint text.
 */
export function readHostFingerprint(destination) {
  return new Promise((resolve) => {
    execFile('ssh-keygen', ['-l', '-F', destination], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      const line = String(stdout).split(/\r?\n/).find(entry => /SHA256:|MD5:/.test(entry))
      resolve(line === undefined ? undefined : line.trim())
    })
  })
}
