/**
 * Filesystem locations this plugin owns on the host machine: the profile data
 * file (targets) and the per-target remote workspace directory. Mirrors the
 * DSH_HOME resolution the rest of the plugin family uses: the environment
 * override wins, the platform home fallback follows.
 * @module dsh-remote/paths
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Expand a leading `~` the way the platform shell would. */
export function expandHome(path) {
  const home = homedir()
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * Resolve the DSH home directory.
 * @param {NodeJS.ProcessEnv} [env] - environment to read `DSH_HOME` from.
 * @returns {string} absolute DSH home path.
 */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = expandHome(raw.trim())
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(homedir(), '.dsh')
}

/** Directory holding the local target registry. */
export function dataDirectory(env = process.env) {
  return resolveDshHome(env)
}

/** Absolute path of the local target registry file (`~/.dsh/dsh-remote.json`). */
export function dataFile(env = process.env) {
  return join(dataDirectory(env), 'dsh-remote.json')
}

/** User's OpenSSH client configuration file. */
export function sshConfigFile(env = process.env) {
  return join(homedir(), '.ssh', 'config')
}

/** Remote-side workspace directory, POSIX, as a shell fragment. */
export const REMOTE_DIR = '$HOME/.dsh-remote'

/**
 * Remote log path for one target, as a shell fragment (single quotes NOT
 * included so callers can embed it inside their own quoting).
 * @param {string} id - target id.
 * @returns {string} shell-safe log path fragment.
 */
export function remoteLogPath(id) {
  return `${REMOTE_DIR}/${id.replace(/[^A-Za-z0-9_-]/g, '')}.log`
}

/** Remote tmux session name for one target. */
export function tmuxSessionName(id) {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)
  return `dsh-remote-${safe}`
}
