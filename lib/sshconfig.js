/**
 * Minimal `~/.ssh/config` reader for target discovery.
 *
 * Deliberate simplifications (mirroring the OpenSSH surface that matters for
 * "which host can I dial"):
 *   - `Match` blocks are skipped: their options are conditional and must
 *     never merge into the Host block above them.
 *   - A multi-pattern `Host a b` line exposes only its first pattern; a line
 *     whose patterns contain `*` or `?` is skipped entirely (wildcard entries
 *     are configuration templates, not dialable hosts).
 *   - `Include` accepts `~`, globs, and several whitespace-separated
 *     pathnames; environment variables and `%` tokens are not expanded.
 *   - A file that already contributed lines is never read twice, which
 *     doubles as the Include cycle guard.
 * @module dsh-remote/sshconfig
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Include recursion guard. */
const MAX_INCLUDE_DEPTH = 8

/** `Keyword value...` (case-insensitive). */
const LINE_RE = /^([A-Za-z0-9_-]+)\s+(.*)$/

/** Expand a leading `~`. */
function expandTilde(path, home = homedir()) {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** Turn one glob segment into a matcher (`*` and `?` only). */
function segmentMatcher(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
}

/** Expand a path's segments against the filesystem, keeping sorted matches. */
function globSegments(prefix, segments) {
  const [head, ...rest] = segments
  if (head === undefined) return [prefix]
  if (!/[*?]/.test(head)) return globSegments(join(prefix, head), rest)
  let names
  try {
    names = readdirSync(prefix)
  } catch {
    return []
  }
  const matcher = segmentMatcher(head)
  return names.filter(name => matcher.test(name)).sort().flatMap(name => globSegments(join(prefix, name), rest))
}

/** Resolve one Include pathname into existing files. */
function resolveInclude(spec, baseDir) {
  const expanded = expandTilde(spec)
  const full = isAbsolute(expanded) ? expanded : join(baseDir, expanded)
  if (!/[*?]/.test(full)) return existsSync(full) ? [full] : []
  const root = /^([A-Za-z]:[\\/]|[\\/])/.exec(full)?.[1] ?? ''
  const segments = full.slice(root.length).split(/[\\/]+/).filter(part => part !== '')
  return globSegments(root === '' ? '/' : root, segments)
}

/** One `Host` block by the options this plugin understands. */
function newBlock(pattern) {
  return { pattern, hostName: undefined, user: undefined, port: undefined, identityFile: undefined, proxyJump: undefined, proxyCommand: undefined }
}

/**
 * Read one config file, expanding `Include` in place.
 * @param {string} file - absolute path.
 * @param {{visited: Set<string>, depth: number}} state - recursion guard.
 * @returns {Array<ReturnType<typeof newBlock>>} parsed blocks.
 */
function readFile(file, state) {
  if (state.visited.has(file) || state.depth > MAX_INCLUDE_DEPTH) return []
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  state.visited.add(file)
  const blocks = []
  let current
  let inMatch = false
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = LINE_RE.exec(trimmed)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()
    if (keyword === 'host') {
      inMatch = false
      const pattern = value.split(/\s+/)[0]
      if (pattern === undefined || /[*?]/.test(pattern)) {
        current = undefined
        continue
      }
      current = newBlock(pattern)
      blocks.push(current)
      continue
    }
    if (keyword === 'match') {
      inMatch = true
      current = undefined
      continue
    }
    if (keyword === 'include') {
      for (const spec of value.split(/\s+/).filter(Boolean)) {
        for (const included of resolveInclude(spec, dirname(file))) {
          blocks.push(...readFile(included, { visited: state.visited, depth: state.depth + 1 }))
        }
      }
      continue
    }
    if (inMatch || current === undefined) continue
    switch (keyword) {
      case 'hostname': current.hostName = value; break
      case 'user': current.user = value; break
      case 'port': current.port = Number.parseInt(value, 10) || undefined; break
      case 'identityfile': current.identityFile = current.identityFile ?? expandTilde(value); break
      case 'proxyjump': current.proxyJump = value; break
      case 'proxycommand': current.proxyCommand = value; break
      default: break
    }
  }
  return blocks
}

/**
 * Parse the user's SSH client configuration into dialable hosts.
 * @param {string} file - absolute path of the config file.
 * @returns {{ hosts: Array<{alias: string, hostName?: string, user?: string, port?: number, identityFile?: string, proxyJump?: string, proxyCommand?: string}>, error?: string }}
 */
export function readSshConfig(file) {
  if (!existsSync(file)) return { hosts: [] }
  const blocks = readFile(file, { visited: new Set(), depth: 0 })
  const seen = new Set()
  const hosts = []
  for (const block of blocks) {
    if (block.pattern === undefined || seen.has(block.pattern)) continue
    seen.add(block.pattern)
    hosts.push({
      alias: block.pattern,
      hostName: block.hostName,
      user: block.user,
      port: block.port,
      identityFile: block.identityFile,
      proxyJump: block.proxyJump,
      proxyCommand: block.proxyCommand,
    })
  }
  return { hosts }
}
