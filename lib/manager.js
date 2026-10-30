/**
 * Target manager: the single owner of runtime state for every remote
 * workspace. It ties the target registry to the four remote operations —
 * discover, probe, bootstrap, run — and keeps the per-target lifecycle
 * (`idle → probing → bootstrapping → starting → running → error`) honest.
 *
 * Invariants:
 *   - the auth token lives in this process only: never written to disk, never
 *     logged, and only handed out by a loopback-fenced status response;
 *   - the local listener is always `127.0.0.1` on a port this manager chose,
 *     and the remote dsh is started on the *same* port number so the browser
 *     authority, the auth cookie authority, and the forwarded port all agree
 *     (dsh binds its auth cookie to `host:port`; a tunnel that renumbers the
 *     port makes every request 401);
 *   - a remote dsh keeps running when the tunnel closes, so reopening a target
 *     is "reconnect", not "restart".
 * @module dsh-remote/manager
 */

import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { channelFor, freeLocalPort, probePort, waitForPort } from './channel.js'
import { FrameProxy } from './frame-proxy.js'
import { buildPlan, formatRate, runStep, tailLines } from './bootstrap.js'
import { PROBE_SCRIPT, classifyProbe, parseProbeOutput, readHostFingerprint, summarizeCaps } from './probe.js'
import { applyConfigSync, readLocalConfig } from './config-sync.js'
import { readSshConfig } from './sshconfig.js'
import { discoverWsl } from './wsl.js'
import { TargetStore } from './store.js'
import { dataFile, remoteLogPath, sshConfigFile, tmuxSessionName } from './paths.js'

/** Probe cache lifetime (FR-2.3). */
const PROBE_TTL_MS = 10 * 60 * 1000

/** Discovery cache lifetime. */
const DISCOVERY_TTL_MS = 60 * 1000

/** Tunnel idle-disconnect window (FR-6.3): the remote keeps running. */
const IDLE_DISCONNECT_MS = 30 * 60 * 1000

/** Health-check attempts after a tunnel comes up. */
const HEALTH_ATTEMPTS = 3

/** Sleep helper. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Minimal async frame queue: lets a generator stream frames produced by
 * callback-style code running concurrently (install logs).
 */
class FrameQueue {
  constructor() {
    this.items = []
    this.waiters = []
    this.closed = false
  }

  push(item) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(item)
    else this.items.push(item)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()
        continue
      }
      if (this.closed) return
      const item = await new Promise(resolve => this.waiters.push(resolve))
      if (item === null) return
      yield item
    }
  }
}

/** Strip a token out of any message before it reaches a log or an error field. */
export function redactToken(text) {
  return String(text ?? '').replace(/(token=)[A-Za-z0-9_-]{10,}/g, '$1<redacted>')
}

/**
 * Normalize the host name the embedding page uses into one of the loopback
 * spellings this plugin will allow the remote to advertise.
 *
 * Why this matters: a DSH auth cookie is `SameSite=Strict`, and a browser
 * compares *sites*, not ports. The desktop UI is served from `localhost:<port>`
 * on some launches and `127.0.0.1:<port>` on others; embedding the remote under
 * the other spelling makes it a different site, so the cookie issued by the
 * token redirect is dropped and the iframe renders "authentication required".
 * The iframe therefore has to use exactly the host the page itself uses, and
 * the remote has to advertise that same authority in `--public-url`.
 * @param {string | undefined} value - `window.location.hostname` from the panel.
 * @returns {string} `localhost`, `127.0.0.1`, or `[::1]`.
 */
export function normalizePublicHost(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '') return '127.0.0.1'
  // A hostname never carries a port, but tolerate one from a hand-written call.
  const bare = raw.replace(/^\[|\]$/g, '')
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return '[::1]'
  const hostPart = bare.split(':')[0]
  if (hostPart === 'localhost') return 'localhost'
  return '127.0.0.1'
}

/**
 * One loopback HTTP exchange against a remote dsh (through the tunnel), without
 * following redirects.
 * @param {number} port - local port.
 * @param {string} path - request path.
 * @param {string} [host] - advertised host name; the Host header must match it.
 * @param {string} [cookie] - Cookie header.
 * @param {{timeoutMs?: number}} [options] - timeout.
 * @returns {Promise<{status: number, setCookie: string[]}>} status and Set-Cookie headers.
 */
export function httpExchange(port, path, host = '127.0.0.1', cookie = '', { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const headers = { host: `${host}:${port}` }
    if (cookie !== '') headers.cookie = cookie
    const request = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, timeout: timeoutMs },
      (response) => {
        response.resume()
        const raw = response.headers['set-cookie']
        resolve({ status: response.statusCode ?? 0, setCookie: Array.isArray(raw) ? raw : raw === undefined ? [] : [raw] })
      },
    )
    request.on('timeout', () => {
      request.destroy()
      resolve({ status: 0, setCookie: [] })
    })
    request.on('error', () => resolve({ status: 0, setCookie: [] }))
    request.end()
  })
}

/**
 * HTTP status of one loopback URL, without following redirects.
 * @param {number} port - local port.
 * @param {string} path - request path.
 * @param {{timeoutMs?: number, host?: string, cookie?: string}} [options] - request options.
 * @returns {Promise<number>} status code, or 0 on transport failure.
 */
export function httpStatus(port, path, options = {}) {
  return httpExchange(port, path, options.host ?? '127.0.0.1', options.cookie ?? '', options).then(result => result.status)
}

/** One target's runtime state, defaulted to idle. */
function emptyRuntime() {
  return {
    state: 'idle',
    phase: undefined,
    url: undefined,
    token: undefined,
    publicHost: '127.0.0.1',
    proxy: undefined,
    proxyPort: undefined,
    remotePort: undefined,
    localPort: undefined,
    version: undefined,
    lastError: undefined,
    startedAt: undefined,
    lastAccess: 0,
    tunnel: undefined,
    busy: false,
    stopping: false,
    reconnecting: false,
    remoteAlive: false,
    logTail: [],
  }
}

/** The manager. */
export class TargetManager {
  /**
   * @param {{logger?: {info?: Function, warn?: Function, error?: Function}, file?: string}} [options] - injection seams.
   */
  constructor(options = {}) {
    this.logger = options.logger ?? console
    this.store = new TargetStore({ file: options.file ?? dataFile() })
    this.runtime = new Map()
    this.probes = new Map()
    this.discovery = { ssh: [], wsl: [], wslError: undefined, at: 0, sshError: undefined }
    this.usedPorts = new Set()
    this.sweepTimer = setInterval(() => { this.sweepIdle() }, 60 * 1000)
    this.sweepTimer.unref?.()
  }

  /** @param {string} id - target id. @returns {object} mutable runtime record. */
  runtimeFor(id) {
    let runtime = this.runtime.get(id)
    if (runtime === undefined) {
      runtime = emptyRuntime()
      this.runtime.set(id, runtime)
    }
    return runtime
  }

  /**
   * Public status of one target.
   * @param {string} id - target id.
   * @returns {object} display-safe status.
   */
  status(id) {
    const target = this.store.get(id)
    if (target === undefined) return undefined
    const runtime = this.runtimeFor(id)
    const probe = this.probes.get(id)
    runtime.lastAccess = Date.now()
    return {
      id: target.id,
      label: target.label,
      kind: target.kind,
      autoStart: target.autoStart === true,
      ssh: target.ssh,
      wsl: target.wsl,
      state: runtime.state,
      phase: runtime.phase,
      url: runtime.state === 'running' ? runtime.url : undefined,
      version: runtime.version ?? probe?.caps?.dshVersion,
      localPort: runtime.localPort,
      remotePort: runtime.remotePort,
      publicHost: runtime.publicHost,
      remoteAlive: runtime.remoteAlive,
      lastError: runtime.lastError,
      startedAt: runtime.startedAt,
      lastProbeAt: probe?.at,
      caps: probe?.caps,
      classification: probe?.classification,
      fingerprint: probe?.fingerprint,
    }
  }

  /** @returns {{targets: Array<object>, discovery: object}} the whole panel payload. */
  list() {
    return {
      targets: this.store.list().map(target => this.status(target.id)).filter(Boolean),
      discovery: this.discoveryPayload(),
    }
  }

  /** Discovery rows annotated with whether a saved target already exists. */
  discoveryPayload() {
    const targets = this.store.list()
    const sshTaken = new Set(targets.filter(t => t.kind === 'ssh' && t.ssh?.alias).map(t => t.ssh.alias))
    const wslTaken = new Set(targets.filter(t => t.kind === 'wsl').map(t => t.wsl?.distro))
    return {
      at: this.discovery.at,
      sshError: this.discovery.sshError,
      wslError: this.discovery.wslError,
      ssh: this.discovery.ssh.map(host => ({ ...host, added: sshTaken.has(host.alias) })),
      wsl: this.discovery.wsl.map(distro => ({ ...distro, added: wslTaken.has(distro.name) })),
    }
  }

  /**
   * Refresh the local discovery lists (ssh config + WSL distros).
   * @param {{force?: boolean}} [options] - bypass the TTL.
   * @returns {Promise<object>} discovery payload.
   */
  async discover({ force = false } = {}) {
    if (!force && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) return this.discoveryPayload()
    let ssh = []
    let sshError
    try {
      const parsed = readSshConfig(sshConfigFile())
      ssh = parsed.hosts
    } catch (error) {
      sshError = error instanceof Error ? error.message : String(error)
    }
    const wsl = await discoverWsl()
    this.discovery = {
      ssh,
      wsl: wsl.distros,
      wslError: wsl.error,
      sshError,
      at: Date.now(),
    }
    return this.discoveryPayload()
  }

  /**
   * Create a target from an untrusted payload.
   * @param {Record<string, unknown>} payload - request body.
   * @returns {object} created status.
   */
  create(payload) {
    const target = this.store.create(payload)
    return this.status(target.id)
  }

  /** Patch one target. */
  update(id, patch) {
    const target = this.store.update(id, patch)
    return target === undefined ? undefined : this.status(id)
  }

  /**
   * Remove a target and tear down its local runtime. The remote install and
   * any running remote process are left alone.
   * @param {string} id - target id.
   * @returns {boolean} whether it existed.
   */
  remove(id) {
    const runtime = this.runtime.get(id)
    if (runtime !== undefined) {
      runtime.stopping = true
      runtime.tunnel?.close()
      this.runtime.delete(id)
    }
    this.probes.delete(id)
    return this.store.remove(id)
  }

  /**
   * Run the environment probe (cached for 10 minutes).
   * @param {string} id - target id.
   * @param {{force?: boolean}} [options] - bypass the cache.
   * @returns {Promise<object>} status with caps.
   */
  async probe(id, { force = false } = {}) {
    const target = this.store.get(id)
    if (target === undefined) throw new Error('target not found')
    const cached = this.probes.get(id)
    if (!force && cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) return this.status(id)
    const runtime = this.runtimeFor(id)
    const previousState = runtime.state
    runtime.state = 'probing'
    runtime.phase = '探测远程环境…'
    runtime.lastError = undefined
    const channel = channelFor(target)
    try {
      const record = await this.probeInternal(id, channel, target)
      runtime.state = previousState === 'running' ? 'running' : 'idle'
      runtime.phase = undefined
      runtime.version = record.caps.dshVersion ?? runtime.version
      return this.status(id)
    } catch (error) {
      runtime.state = 'error'
      runtime.phase = undefined
      runtime.lastError = redactToken(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      channel.dispose()
    }
  }

  /**
   * Probe one target, storing the result.
   * @param {string} id - target id.
   * @param {import('./channel.js').Channel} channel - connector.
   * @param {object} target - saved target.
   * @returns {Promise<{caps: object, classification: object, fingerprint?: string, at: number}>}
   */
  async probeInternal(id, channel, target) {
    const result = await channel.exec(PROBE_SCRIPT, { timeoutMs: 20000 })
    if (result.code !== 0) {
      throw new Error(result.error ?? tailLines(result.stderr, 6) ?? 'probe failed')
    }
    const { ok, fields } = parseProbeOutput(result.stdout)
    if (!ok) throw new Error(`探测输出不完整，可能远程 shell 不是 bash：${tailLines(result.stdout, 4)}`)
    const classification = classifyProbe(fields)
    const caps = {
      ...summarizeCaps(fields),
      nodeOk: classification.nodeOk,
      dshOk: classification.dshOk,
      status: classification.status,
      reasons: classification.reasons,
      canBootstrap: classification.canBootstrap,
    }
    let fingerprint
    if (target.kind === 'ssh') {
      fingerprint = await readHostFingerprint(channel.describe())
    }
    const record = { caps, classification, fingerprint, at: Date.now() }
    this.probes.set(id, record)
    return record
  }

  /**
   * Build the install plan for one target (the wizard's review step).
   * @param {string} id - target id.
   * @returns {Promise<object>} plan with display-safe mirrors.
   */
  async plan(id) {
    const target = this.store.get(id)
    if (target === undefined) throw new Error('target not found')
    const runtime = this.runtimeFor(id)
    runtime.phase = '生成安装计划…'
    const channel = channelFor(target)
    try {
      const record = await this.probeInternal(id, channel, target)
      return await this.planFor(channel, record)
    } finally {
      channel.dispose()
      runtime.phase = undefined
    }
  }

  /** Build a plan from a probe record. */
  async planFor(channel, record) {
    const plan = await buildPlan({ channel, caps: record.caps })
    return {
      blocked: plan.blocked,
      steps: plan.steps.map(step => ({
        id: step.id,
        title: step.title,
        detail: step.detail,
        path: step.path,
        sizeMB: step.sizeMB,
        required: step.required,
        informational: step.informational === true,
        source: step.source,
        registry: step.registry,
        version: step.version,
        commands: (step.commands ?? []).map(command => ({ label: command.label, script: command.script, stream: command.stream === true })),
      })),
      mirrors: {
        node: plan.mirrors.node.map(mirror => ({ id: mirror.id, label: mirror.label, rate: formatRate(mirror.bytesPerSecond ?? 0) })),
        npm: plan.mirrors.npm.map(mirror => ({ id: mirror.id, label: mirror.label, rate: formatRate(mirror.bytesPerSecond ?? 0) })),
      },
      caps: record.caps,
    }
  }

  /**
   * Stream the install: probe, plan, then execute the selected steps with
   * live output. Yields NDJSON frames as they happen.
   * @param {string} id - target id.
   * @param {{skip?: string[], signal?: AbortSignal}} [options] - step selection and abort.
   * @returns {AsyncGenerator<object>} frames.
   */
  async *bootstrap(id, options = {}) {
    const target = this.store.get(id)
    if (target === undefined) {
      yield { type: 'error', message: 'target not found' }
      return
    }
    const runtime = this.runtimeFor(id)
    if (runtime.busy) {
      yield { type: 'error', message: '该目标正在忙（探测/安装/启动进行中），请稍后再试。' }
      return
    }
    runtime.busy = true
    runtime.state = 'bootstrapping'
    runtime.phase = '探测远程环境…'
    runtime.lastError = undefined
    const queue = new FrameQueue()
    const producer = (async () => {
      const channel = channelFor(target)
      try {
        queue.push({ type: 'phase', phase: 'probe', message: '探测远程环境…' })
        const record = await this.probeInternal(id, channel, target)
        queue.push({ type: 'caps', caps: record.caps })
        queue.push({ type: 'phase', phase: 'plan', message: '生成安装计划…' })
        const plan = await this.planFor(channel, record)
        if (plan.blocked !== undefined) {
          queue.push({ type: 'error', message: plan.blocked })
          return
        }
        queue.push({ type: 'plan', plan })
        const skip = new Set(options.skip ?? [])
        const chosen = plan.steps.filter(step => step.required === true && !skip.has(step.id))
        if (chosen.length === 0) {
          queue.push({ type: 'done', ok: true, message: '所选步骤都跳过了，远程环境未改动。' })
          return
        }
        for (const step of chosen) {
          runtime.phase = step.title
          const outcome = await runStep({ channel, step, emit: frame => queue.push(frame), signal: options.signal })
          if (!outcome.ok) {
            runtime.state = 'error'
            runtime.lastError = redactToken(outcome.message ?? '安装失败')
            queue.push({ type: 'error', message: runtime.lastError })
            return
          }
        }
        runtime.phase = '重新探测…'
        const after = await this.probeInternal(id, channel, target)
        runtime.state = 'idle'
        runtime.phase = undefined
        queue.push({ type: 'done', ok: true, caps: after.caps, message: '安装完成。' })
      } catch (error) {
        runtime.state = 'error'
        runtime.phase = undefined
        runtime.lastError = redactToken(error instanceof Error ? error.message : String(error))
        queue.push({ type: 'error', message: runtime.lastError })
      } finally {
        runtime.busy = false
        channel.dispose()
        queue.close()
      }
    })()
    for await (const frame of queue) yield frame
    await producer
  }

  /**
   * Start (or reconnect to) the remote dsh, open the tunnel, then put the
   * auth-injecting proxy in front of it for the iframe.
   * @param {string} id - target id.
   * @param {{publicHost?: string}} [options] - accepted for compatibility; the
   *   embedding site no longer matters because the proxy holds the credential.
   * @returns {Promise<object>} status of the running target.
   */
  async start(id, options = {}) {
    const target = this.store.get(id)
    if (target === undefined) throw new Error('target not found')
    const runtime = this.runtimeFor(id)
    if (runtime.state === 'running' && runtime.url !== undefined) {
      runtime.lastAccess = Date.now()
      return this.status(id)
    }
    if (runtime.busy) throw new Error('该目标正在处理中，请稍等。')
    runtime.busy = true
    runtime.state = 'starting'
    runtime.lastError = undefined
    runtime.stopping = false
    runtime.publicHost = '127.0.0.1'
    const channel = channelFor(target)
    try {
      runtime.phase = '探测远程环境…'
      const record = await this.probeInternal(id, channel, target)
      runtime.version = record.caps.dshVersion
      if (record.caps.nodeOk !== true) {
        throw new Error(record.caps.reasons?.[0] ?? '远程缺少可用的 Node，请先安装。')
      }
      if (record.caps.dshOk !== true) {
        throw new Error('远程没有 dsh 命令，请先点“安装”完成 bootstrap。')
      }
      runtime.phase = '寻找可复用的远程实例…'
      const recovered = await this.tryRecover(id, channel, runtime, target)
      if (!recovered) {
        runtime.phase = '选择端口…'
        const port = await this.pickPort(channel)
        runtime.phase = `启动远程 dsh（端口 ${port}）…`
        const launched = await this.launch(id, channel, runtime, port, record.caps)
        if (!launched.ok) throw new Error(launched.message)
      }
      runtime.phase = '建立隧道…'
      if (target.kind === 'ssh') {
        const tunnel = await channel.openTunnel({ localPort: runtime.localPort, remotePort: runtime.remotePort })
        runtime.tunnel = tunnel
        this.watchTunnel(id, channel, runtime)
        if (!(await waitForPort(runtime.localPort, { timeoutMs: 10000 }))) {
          throw new Error('隧道没有就绪：本地端口没有开始监听。请确认 ssh 可以建立端口转发。')
        }
      }
      runtime.phase = '健康检查…'
      const healthy = await this.healthCheck(runtime)
      if (!healthy.ok) throw new Error(healthy.message)
      runtime.phase = '准备内嵌代理…'
      runtime.proxy?.close()
      const proxy = new FrameProxy({
        targetPort: runtime.localPort,
        remotePort: runtime.remotePort,
        token: runtime.token,
      })
      await proxy.start()
      const proxied = await httpStatus(proxy.port, '/')
      if (proxied !== 200) {
        proxy.close()
        throw new Error(`内嵌代理校验失败：经代理访问远程首页返回 HTTP ${proxied}（期望 200）。`)
      }
      runtime.proxy = proxy
      runtime.state = 'running'
      runtime.phase = undefined
      runtime.remoteAlive = true
      runtime.startedAt = runtime.startedAt ?? Date.now()
      // The iframe loads the proxy, never the remote itself: no token in the
      // page URL and no cookie the browser has to hold.
      runtime.url = proxy.url
      runtime.lastAccess = Date.now()
      return this.status(id)
    } catch (error) {
      runtime.state = 'error'
      runtime.phase = undefined
      runtime.lastError = redactToken(error instanceof Error ? error.message : String(error))
      runtime.proxy?.close()
      runtime.proxy = undefined
      runtime.tunnel?.close()
      runtime.tunnel = undefined
      throw new Error(runtime.lastError)
    } finally {
      runtime.busy = false
      channel.dispose()
    }
  }

  /**
   * Verify the URL the iframe will load *end to end*: the token redirect must
   * answer 303, and the cookie it issues must be accepted on the following
   * request. Checking only the 303 is not enough — a cookie the browser will
   * refuse (or a host that does not match the cookie authority) still shows up
   * as "running" and then renders the 401 page inside the panel.
   * @param {object} runtime - runtime record.
   * @returns {Promise<{ok: boolean, message?: string}>} check outcome.
   */
  async healthCheck(runtime) {
    let lastStatus = 0
    let detail = ''
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      const redirect = await httpExchange(runtime.localPort, `/?token=${runtime.token}`, runtime.publicHost)
      lastStatus = redirect.status
      if (redirect.status !== 303 && redirect.status !== 200) {
        await sleep(800)
        continue
      }
      if (redirect.status === 200) return { ok: true }
      const cookie = redirect.setCookie.map(line => line.split(';')[0]).join('; ')
      const page = await httpExchange(runtime.localPort, '/', runtime.publicHost, cookie)
      if (page.status === 200) return { ok: true }
      lastStatus = page.status
      detail = cookie === '' ? '（没有收到认证 cookie）' : ''
      await sleep(500)
    }
    return {
      ok: false,
      message: lastStatus === 0
        ? '健康检查失败：转发端口没有响应。远程 dsh 可能已退出，请查看安装/启动日志。'
        : `健康检查失败：认证后的页面返回 HTTP ${lastStatus}${detail}。远程 dsh 的状态可能已过期，请点“重启”。`,
    }
  }

  /**
   * Launch a fresh remote dsh under tmux (or setsid+nohup) and capture the
   * printed token from its log.
   * @param {string} id - target id.
   * @param {import('./channel.js').Channel} channel - connector.
   * @param {object} runtime - runtime record.
   * @param {number} port - port used on both sides.
   * @param {object} caps - probe caps.
   * @param {string} publicHost - host name the embedding page uses.
   * @returns {Promise<{ok: boolean, message?: string}>} launch outcome.
   */
  async launch(id, channel, runtime, port, caps, publicHost = '127.0.0.1') {
    const dshBin = caps.dshPath ?? '$HOME/.local/bin/dsh'
    const logPath = remoteLogPath(id)
    const session = tmuxSessionName(id)
    const publicUrl = `http://${publicHost}:${port}/`
    const command = `${dshBin} web --no-open --port ${port} --public-url ${publicUrl} --trusted-host ${publicHost}:${port}`
    const pidFile = `$HOME/.dsh-remote/${session}.pid`
    const runner = `$HOME/.dsh-remote/${session}.run.sh`
    const haveTmux = (caps.tmuxPath ?? '') !== ''
    // The runner writes its own pid and then `exec`s dsh, so the pid file always
    // names the live process. `setsid <cmd> &` alone would record setsid's pid,
    // which exits immediately after forking — a stale pid that breaks recovery
    // and graceful stop.
    const runnerContent = [
      '#!/bin/sh',
      `echo $$ > "${pidFile}"`,
      `exec ${command}`,
      '',
    ].join('\n')
    const runnerB64 = Buffer.from(runnerContent, 'utf8').toString('base64')
    const startScript = String.raw`
mkdir -p "$HOME/.dsh-remote"
# Reap a previous instance of THIS target before starting a new one: a broken
# patch or a crashed boot would otherwise leave an orphaned server behind after
# the log is truncated and its pid file goes stale.
oldport=$(grep -o 'http://[A-Za-z0-9._-]*:[0-9]*/' "${logPath}" 2>/dev/null | tail -n 1 | sed -n 's|.*:\([0-9]*\)/|\1|p')
if [ -n "$oldport" ] && command -v pkill >/dev/null 2>&1; then
  pkill -f "dsh web --no-open --port $oldport" 2>/dev/null
fi
: > "${logPath}"
printf '%s' '${runnerB64}' | base64 -d > "${runner}"
chmod +x "${runner}"
if ${haveTmux ? 'true' : 'false'} && command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t ${session} 2>/dev/null
  tmux new-session -d -s ${session} -c "$HOME" '"${runner}" >> "${logPath}" 2>&1'
else
  if command -v setsid >/dev/null 2>&1; then
    setsid "${runner}" >> "${logPath}" 2>&1 &
  else
    nohup "${runner}" >> "${logPath}" 2>&1 &
  fi
fi
sleep 1
printf 'LAUNCHED\n'
`
    const started = await channel.exec(startScript, { timeoutMs: 30000 })
    if (started.code !== 0) {
      return { ok: false, message: `无法启动远程 dsh：${tailLines(started.stderr || started.stdout, 8) || started.error || '未知错误'}` }
    }
    // Poll the log for the token line. Reading it remotely keeps the token out
    // of any host-side log.
    const waitScript = String.raw`
i=0
while [ $i -lt 120 ]; do
  line=$(grep -o 'http://[A-Za-z0-9._-]*:[0-9]*/?token=[A-Za-z0-9_-]*' "${logPath}" 2>/dev/null | tail -n 1)
  if [ -n "$line" ]; then printf 'FOUND=%s\n' "$line"; exit 0; fi
  if command -v tmux >/dev/null 2>&1; then
    if ! tmux has-session -t ${session} 2>/dev/null; then printf 'DEAD\n'; tail -n 25 "${logPath}" 2>/dev/null; exit 3; fi
  fi
  i=$((i + 1))
  sleep 0.5
done
printf 'TIMEOUT\n'
tail -n 25 "${logPath}" 2>/dev/null
exit 4
`
    const waited = await channel.exec(waitScript, { timeoutMs: 90000 })
    const found = /FOUND=(http:\/\/([A-Za-z0-9._-]+):(\d+)\/\?token=([A-Za-z0-9_-]+))/.exec(waited.stdout ?? '')
    if (found === null) {
      const detail = tailLines((waited.stdout ?? '').replace(/^(TIMEOUT|DEAD)\s*$/gm, ''), 12)
      return {
        ok: false,
        message: `远程 dsh 没有在 60 秒内打印访问地址。${detail === '' ? '' : `\n${detail}`}`,
      }
    }
    runtime.publicHost = found[2]
    runtime.remotePort = Number(found[3])
    runtime.localPort = port
    runtime.token = found[4]
    return { ok: true }
  }

  /**
   * Reuse a remote dsh that is still running from a previous session (DSH
   * restart, panel closed): recover its token from the log, then only rebuild
   * the tunnel.
   * @param {string} id - target id.
   * @param {import('./channel.js').Channel} channel - connector.
   * @param {object} runtime - runtime record.
   * @param {object} target - saved target (connector kind decides the port rule).
   * @param {string} publicHost - host name the embedding page uses.
   * @returns {Promise<boolean>} whether a live instance was adopted.
   */
  async tryRecover(id, channel, runtime, target, publicHost = '127.0.0.1') {
    const logPath = remoteLogPath(id)
    const session = tmuxSessionName(id)
    // Liveness is decided by "is something still listening on the port the log
    // advertises", not by a recorded pid: the pid file is a convenience for
    // stopping, while a listening socket is the actual proof of a live server.
    const script = String.raw`
line=$(grep -o 'http://[A-Za-z0-9._-]*:[0-9]*/?token=[A-Za-z0-9_-]*' "${logPath}" 2>/dev/null | tail -n 1)
if [ -n "$line" ]; then
  port=$(printf '%s' "$line" | sed -n 's|.*://[A-Za-z0-9._-]*:\([0-9]*\)/.*|\1|p')
  if [ -n "$port" ] && (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    exec 3>&- 2>/dev/null
    printf 'ALIVE=%s\n' "$line"
    exit 0
  fi
fi
if command -v tmux >/dev/null 2>&1 && tmux has-session -t ${session} 2>/dev/null; then
  line=$(grep -o 'http://[A-Za-z0-9._-]*:[0-9]*/?token=[A-Za-z0-9_-]*' "${logPath}" 2>/dev/null | tail -n 1)
  if [ -n "$line" ]; then printf 'ALIVE=%s\n' "$line"; exit 0; fi
fi
pidfile="$HOME/.dsh-remote/${session}.pid"
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  line=$(grep -o 'http://[A-Za-z0-9._-]*:[0-9]*/?token=[A-Za-z0-9_-]*' "${logPath}" 2>/dev/null | tail -n 1)
  if [ -n "$line" ]; then printf 'ALIVE=%s\n' "$line"; exit 0; fi
fi
printf 'NOT_ALIVE\n'
`
    const result = await channel.exec(script, { timeoutMs: 20000 })
    const alive = /ALIVE=(http:\/\/([A-Za-z0-9._-]+):(\d+)\/\?token=([A-Za-z0-9_-]+))/.exec(result.stdout ?? '')
    if (alive === null) return false
    // The instance printed its own `--public-url`, whose port is the port this
    // manager chose at launch — the same number on both sides. Reusing it
    // keeps browser authority, cookie authority and forward in agreement.
    const launchedHost = alive[2]
    const port = Number(alive[3])
    const token = alive[4]
    // An instance advertising another host name cannot serve this page: its
    // cookie authority would differ from the request authority (or the site
    // would differ and a Strict cookie never be sent). Relaunch on the right
    // host instead of adopting it.
    if (launchedHost !== publicHost) return false
    // An SSH target must bind that port locally for the forward, so a busy
    // local port means a fresh launch is the better answer. A WSL target needs
    // no forward, and there the open port IS the remote: expecting it closed
    // would reject every healthy instance.
    if (target.kind === 'ssh' && await probePort(port)) return false
    runtime.publicHost = launchedHost
    runtime.remotePort = port
    runtime.localPort = port
    runtime.token = token
    return true
  }

  /**
   * Choose one port that is free both locally and on the remote side.
   * @param {import('./channel.js').Channel} channel - connector.
   * @returns {Promise<number>} port.
   */
  async pickPort(channel) {
    // Preferred window is the ephemeral range so the choice never collides
    // with a service the user runs.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = attempt < 12 ? 20000 + Math.floor(Math.random() * 30000) : await freeLocalPort()
      if (candidate < 1024 || candidate > 65535) continue
      if (this.usedPorts.has(candidate)) continue
      if (await probePort(candidate)) continue
      const remote = await channel.exec(`(exec 3<>/dev/tcp/127.0.0.1/${candidate}) 2>/dev/null && printf 'busy' || printf 'free'`, { timeoutMs: 10000 })
      if (!String(remote.stdout ?? '').includes('free')) continue
      this.usedPorts.add(candidate)
      return candidate
    }
    throw new Error('找不到同时空闲的本地/远程端口，请稍后重试。')
  }

  /**
   * Re-open a dropped tunnel with exponential backoff (1s → 30s), keeping the
   * token and the remote process untouched.
   * @param {string} id - target id.
   * @param {import('./channel.js').Channel} channel - connector (reused).
   * @param {object} runtime - runtime record.
   */
  watchTunnel(id, channel, runtime) {
    const tunnel = runtime.tunnel
    if (tunnel?.exit === undefined) return
    tunnel.exit.then(async () => {
      runtime.tunnel = undefined
      if (runtime.state !== 'running' || runtime.stopping || runtime.reconnecting) return
      runtime.reconnecting = true
      const delays = [1000, 2000, 4000, 8000, 16000, 30000]
      try {
        for (const delay of delays) {
          await sleep(delay)
          if (runtime.state !== 'running' || runtime.stopping) return
          try {
            const next = await channel.openTunnel({ localPort: runtime.localPort, remotePort: runtime.remotePort })
            if (next === null) return
            if (await waitForPort(runtime.localPort, { timeoutMs: 8000 })) {
              runtime.tunnel = next
              this.watchTunnel(id, channel, runtime)
              return
            }
            next.close()
          } catch {
            /* try the next delay */
          }
        }
        runtime.state = 'error'
        runtime.lastError = '隧道重连失败：请检查网络后点“连接”重建。'
      } finally {
        runtime.reconnecting = false
      }
    })
  }

  /**
   * Stop the remote dsh for one target and release the tunnel.
   * @param {string} id - target id.
   * @returns {Promise<object>} status after stopping.
   */
  async stop(id) {
    const target = this.store.get(id)
    if (target === undefined) throw new Error('target not found')
    const runtime = this.runtimeFor(id)
    runtime.stopping = true
    const channel = channelFor(target)
    const session = tmuxSessionName(id)
    const port = runtime.remotePort
    const script = String.raw`
if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${session} 2>/dev/null; fi
pidfile="$HOME/.dsh-remote/${session}.pid"
if [ -f "$pidfile" ]; then
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; sleep 0.3; kill -9 "$pid" 2>/dev/null; fi
  rm -f "$pidfile"
fi
${port === undefined ? '' : `if command -v pkill >/dev/null 2>&1; then pkill -f 'dsh web --port ${port}' 2>/dev/null; fi`}
printf 'STOPPED\n'
`
    try {
      await channel.exec(script, { timeoutMs: 20000 })
    } catch {
      /* stopping is best effort: the local tunnel must still be released */
    } finally {
      channel.dispose()
    }
    runtime.tunnel?.close()
    runtime.tunnel = undefined
    runtime.proxy?.close()
    runtime.proxy = undefined
    runtime.proxyPort = undefined
    runtime.state = 'idle'
    runtime.phase = undefined
    runtime.url = undefined
    runtime.token = undefined
    runtime.remoteAlive = false
    runtime.startedAt = undefined
    if (runtime.localPort !== undefined) this.usedPorts.delete(runtime.localPort)
    runtime.localPort = undefined
    runtime.remotePort = undefined
    runtime.stopping = false
    return this.status(id)
  }

  /**
   * Record what origin the panel actually runs on. The remote's auth cookie is
   * `SameSite=Strict`, so the embedding host must match the page's site; this
   * report is what makes "which host is the page on" answerable instead of
   * guessed. Written next to the registry, never containing credentials.
   * @param {Record<string, unknown>} report - `{origin, href, host, userAgent}` from the browser.
   * @returns {string} path written.
   */
  recordClientReport(report) {
    const file = join(dirname(this.store.file), 'dsh-remote-client.json')
    const payload = {
      at: new Date().toISOString(),
      origin: typeof report.origin === 'string' ? report.origin : undefined,
      host: typeof report.host === 'string' ? report.host : undefined,
      href: typeof report.href === 'string' ? report.href : undefined,
      userAgent: typeof report.userAgent === 'string' ? report.userAgent : undefined,
    }
    writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8' })
    return file
  }

  /**
   * Preview the local configuration items that can be ported to this target.
   * Secrets never appear here: only names and counts.
   * @param {string} id - target id.
   * @returns {Promise<object>} preview.
   */
  async configPreview(id) {
    if (this.store.get(id) === undefined) throw new Error('target not found')
    const local = readLocalConfig()
    const caps = this.probes.get(id)?.caps
    return {
      profile: local.profile,
      patchSource: local.patchSource,
      hasAny: local.hasAny,
      items: local.items,
      remote: {
        probed: caps !== undefined,
        needsConfig: caps === undefined ? true : caps.needsConfig !== false,
        hasProfilePatch: caps?.hasProfilePatch === true,
        providerCount: caps?.providerCount ?? 0,
      },
    }
  }

  /**
   * Port the selected local configuration items into the remote profile, then
   * (optionally) restart the remote dsh so it picks them up.
   * @param {string} id - target id.
   * @param {{items?: string[], restart?: boolean, publicHost?: string}} [options] - selection.
   * @returns {Promise<object>} outcome with the refreshed caps.
   */
  async syncConfig(id, options = {}) {
    const target = this.store.get(id)
    if (target === undefined) throw new Error('target not found')
    const runtime = this.runtimeFor(id)
    if (runtime.busy) throw new Error('该目标正在忙，请稍后再试。')
    const local = readLocalConfig()
    const selected = new Set(
      Array.isArray(options.items) && options.items.length > 0
        ? options.items
        : local.items.filter(item => item.defaultOn === true).map(item => item.id),
    )
    runtime.busy = true
    runtime.phase = '移植本地配置…'
    const channel = channelFor(target)
    let refreshed
    try {
      const result = await applyConfigSync({ channel, local, selected })
      if (!result.ok) throw new Error(result.message ?? '配置移植失败')
      const record = await this.probeInternal(id, channel, target).catch(() => undefined)
      refreshed = record?.caps
      runtime.phase = undefined
      let restarted = false
      if (options.restart === true && runtime.state === 'running') {
        // stop()/start() own the busy flag themselves.
        runtime.busy = false
        try {
          await this.stop(id)
          await this.start(id, { publicHost: options.publicHost })
          restarted = true
        } finally {
          runtime.busy = true
        }
      }
      return { ok: true, wrote: result.wrote, backups: result.backups, caps: refreshed, restarted }
    } catch (error) {
      runtime.lastError = redactToken(error instanceof Error ? error.message : String(error))
      runtime.state = 'error'
      throw error
    } finally {
      runtime.busy = false
      runtime.phase = undefined
      channel.dispose()
    }
  }

  /**
   * Restart the remote dsh (stop + start), keeping the same registry entry.
   * @param {string} id - target id.
   * @param {{publicHost?: string}} [options] - the host the embedding page uses.
   * @returns {Promise<object>} status after the restart.
   */
  async restart(id, options = {}) {
    await this.stop(id)
    return this.start(id, options)
  }

  /** Disconnect tunnels that no panel has touched for the idle window. */
  sweepIdle() {
    const now = Date.now()
    for (const [id, runtime] of this.runtime) {
      // A WSL target has no tunnel but always has the proxy; either one being
      // present means there is something to release.
      if (runtime.state !== 'running' || (runtime.tunnel === undefined && runtime.proxy === undefined)) continue
      if (now - runtime.lastAccess < IDLE_DISCONNECT_MS) continue
      runtime.tunnel?.close()
      runtime.tunnel = undefined
      runtime.proxy?.close()
      runtime.proxy = undefined
      runtime.proxyPort = undefined
      runtime.state = 'idle'
      runtime.remoteAlive = true
      runtime.url = undefined
      runtime.phase = '空闲已断开隧道（远程 dsh 仍在运行）'
      this.logger.info?.(`[dsh-remote] idle disconnect ${id}`)
    }
  }

  /** Release every runtime resource. */
  dispose() {
    clearInterval(this.sweepTimer)
    for (const runtime of this.runtime.values()) {
      runtime.stopping = true
      runtime.tunnel?.close()
      runtime.proxy?.close()
    }
    this.runtime.clear()
  }
}
