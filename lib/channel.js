/**
 * Delivery channels: how one target is reached from the host process.
 *
 * Two connectors share one shape (`exec`, `openTunnel`, `describe`):
 *   - {@link SshChannel} drives the local OpenSSH client. Reusing `ssh` means
 *     the user's own `~/.ssh/config`, keys, ssh-agent, ProxyJump and
 *     ProxyCommand all apply exactly as they do in a terminal — a hand-rolled
 *     ssh2 client would have to re-implement (and could silently mis-handle)
 *     each of those.
 *   - {@link WslChannel} drives `wsl.exe -d <distro>`, which needs no tunnel:
 *     Windows reaches a WSL-bound loopback port through the WSL localhost
 *     forwarding (NAT mode) or the shared namespace (mirrored mode).
 *
 * Every remote command runs under `bash -c` with a PATH preamble, so the
 * toolchain the probe found is the toolchain the later steps call: a
 * non-login shell keeps MOTD/banner noise out of machine-readable output.
 * @module dsh-remote/channel
 */

import { spawn } from 'node:child_process'
import net from 'node:net'

/**
 * PATH preamble prepended to every remote script. nvm is sourced first so the
 * no-sudo Node this plugin installs can then take precedence: anything later
 * appended to PATH stays behind `~/.local`.
 */
const PATH_PREAMBLE = [
  'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi',
  'export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"',
].join('\n')

/** POSIX single-quote a string. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** SSH options applied to every invocation (exec and tunnel alike). */
const SSH_BASE_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'UpdateHostKeys=no',
  '-o', 'LogLevel=ERROR',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
]

/** Default per-command timeout: probes and log reads must never hang the panel. */
export const DEFAULT_EXEC_TIMEOUT_MS = 25000

/** Channel interface every connector implements. */
export class Channel {
  /** @returns {string} human-readable destination, safe to display. */
  describe() {
    return 'unknown'
  }

  /**
   * Run one script on the remote side.
   * @param {string} script - bash script, already free of host-side quoting.
   * @param {{timeoutMs?: number, onData?: (chunk: string) => void, signal?: AbortSignal}} [options] - execution options.
   * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean, error?: string}>}
   */
  async exec(script, options) {
    throw new Error('not implemented')
  }

  /**
   * Open a local loopback listener forwarding to the remote port.
   * @param {{localPort: number, remotePort: number}} _options - port pair.
   * @returns {Promise<object | null>} tunnel handle, or null when the connector needs none.
   */
  async openTunnel(_options) {
    return null
  }

  /** Release any pooled resource. */
  async dispose() {}
}

/**
 * Spawn a local process and collect its output, with a hard timeout and an
 * optional abort signal. Never throws for a non-zero exit: callers decide.
 * `input` is written to the child's stdin — remote scripts travel this way so
 * their quoting never passes through a Windows command line or a nested shell.
 */
function run(command, args, { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, onData, signal, input } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, env: process.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearAbort()
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, Math.max(1000, timeoutMs))
    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const clearAbort = () => signal?.removeEventListener?.('abort', onAbort)
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => { /* the peer may close early; the exit code carries the verdict */ })
      child.stdin.end(input)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024)
      onData?.(chunk, 'stdout')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-1 * 1024 * 1024)
      onData?.(chunk, 'stderr')
    })
    child.on('error', (error) => {
      finish({ code: -1, stdout, stderr, timedOut, error: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** SSH connector: dials a host through the local OpenSSH client. */
export class SshChannel extends Channel {
  /** @param {{ssh?: {alias?: string, hostName?: string, user?: string, port?: number, identityFile?: string, proxyJump?: string}}} target - saved target. */
  constructor(target) {
    super()
    const ssh = target.ssh ?? {}
    this.alias = ssh.alias
    this.hostName = ssh.hostName
    this.user = ssh.user
    this.port = ssh.port
    this.identityFile = ssh.identityFile
    this.proxyJump = ssh.proxyJump
    this.connected = false
  }

  /** @returns {string} display destination. */
  describe() {
    if (this.alias !== undefined) return this.alias
    const user = this.user === undefined ? '' : `${this.user}@`
    return `${user}${this.hostName ?? ''}`
  }

  /**
   * argv up to (and including) the destination. A config alias is passed
   * alone so OpenSSH resolves every option itself; a manual target passes its
   * explicit flags.
   * @returns {string[]} ssh arguments.
   */
  destinationArgs() {
    const args = [...SSH_BASE_OPTIONS]
    if (this.alias !== undefined) return [...args, this.alias]
    if (this.port !== undefined) args.push('-p', String(this.port))
    if (this.user !== undefined) args.push('-l', this.user)
    if (this.identityFile !== undefined) args.push('-i', this.identityFile)
    if (this.proxyJump !== undefined) args.push('-J', this.proxyJump)
    args.push(this.hostName ?? '')
    return args
  }

  /** @inheritdoc */
  async exec(script, options = {}) {
    // The script travels on stdin: `ssh host bash` reads it there, so no
    // host-side quoting ever has to survive a shell round trip.
    const result = await run('ssh', [...this.destinationArgs(), 'bash'], {
      ...options,
      input: `${PATH_PREAMBLE}\n${script}\n`,
    })
    if (result.code === 255 && options.allowFailure !== true) {
      this.connected = false
      return { ...result, error: classifySshFailure(result.stderr) }
    }
    this.connected = result.code === 0
    return result
  }

  /** @inheritdoc */
  async openTunnel({ localPort, remotePort, onLog }) {
    const args = [
      ...this.destinationArgs(),
      '-N', '-T',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ]
    const child = spawn('ssh', args, { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
      onLog?.(chunk)
    })
    const exit = new Promise((resolve) => {
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
      child.on('error', (error) => resolve({ code: -1, stderr: error instanceof Error ? error.message : String(error) }))
    })
    return {
      kind: 'ssh-forward',
      localPort,
      remotePort,
      pid: child.pid,
      exit,
      stderrText: () => stderr,
      close: () => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      },
    }
  }
}

/** WSL connector: runs commands inside a distribution, no tunnel needed. */
export class WslChannel extends Channel {
  /** @param {{wsl?: {distro?: string}}} target - saved target. */
  constructor(target) {
    super()
    this.distro = target.wsl?.distro ?? ''
  }

  /** @returns {string} display destination. */
  describe() {
    return `WSL: ${this.distro}`
  }

  /** @inheritdoc */
  async exec(script, options = {}) {
    // stdin, not a command-line argument: a WSL command line is re-parsed by
    // Windows rules, which mangles quotes and `$(...)` in a long script.
    const result = await run('wsl.exe', ['-d', this.distro, '--', 'bash'], {
      ...options,
      input: `${PATH_PREAMBLE}\n${script}\n`,
    })
    if (result.code === -1 && result.error !== undefined) {
      return { ...result, error: `wsl.exe failed: ${result.error}` }
    }
    const denied = /E_ACCESSDENIED|WslE|拒绝访问/.test(result.stderr)
    if (denied && result.code !== 0) {
      return { ...result, error: 'WSL refused access to the distribution (Wsl/E_ACCESSDENIED).' }
    }
    return result
  }

  /** @inheritdoc */
  async openTunnel() {
    return null
  }
}

/**
 * Build the connector for one saved target.
 * @param {Record<string, unknown>} target - saved target.
 * @returns {Channel} connector.
 */
export function channelFor(target) {
  return target.kind === 'wsl' ? new WslChannel(target) : new SshChannel(target)
}

/**
 * Explain an ssh-level failure (exit 255) in terms the user can act on.
 * @param {string} stderr - ssh stderr.
 * @returns {string} actionable message.
 */
export function classifySshFailure(stderr) {
  const text = (stderr ?? '').trim()
  if (text === '') return 'ssh failed with no diagnostic output'
  if (/Permission denied|publickey|password/i.test(text)) {
    return `${text}\n认证失败：请先在终端里确认 \`ssh <host>\` 可以免密登录（密钥、ssh-agent 或 ~/.ssh/config 的 IdentityFile）。`
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return `${text}\n主机密钥校验失败：确认这台机器没有被替换后，用 \`ssh-keygen -R <host>\` 清掉旧指纹再重试。`
  }
  if (/Name or service not known|Could not resolve hostname/i.test(text)) {
    return `${text}\n主机名解析失败：检查 ~/.ssh/config 里的 HostName 或 DNS。`
  }
  if (/Connection timed out|Connection refused|No route to host/i.test(text)) {
    return `${text}\n网络不可达：确认主机在线、端口可达（校园网/云安全组），必要时通过 ProxyJump 跳板。`
  }
  return text
}

/**
 * Ask the OS for a free loopback port by binding port 0 and closing it.
 * @returns {Promise<number>} a port number that was free a moment ago.
 */
export function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Whether a loopback TCP port accepts connections right now.
 * @param {number} port - port on 127.0.0.1.
 * @param {{timeoutMs?: number}} [options] - connect timeout.
 * @returns {Promise<boolean>} true when the connect succeeds.
 */
export function probePort(port, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Wait until a loopback port answers, or the deadline passes.
 * @param {number} port - port on 127.0.0.1.
 * @param {{timeoutMs?: number, intervalMs?: number}} [options] - budget.
 * @returns {Promise<boolean>} whether the port came up.
 */
export async function waitForPort(port, { timeoutMs = 8000, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(port)) return true
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return false
}
