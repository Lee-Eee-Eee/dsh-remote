/**
 * Remote bootstrap: turn a probe that says "Node missing" or "dsh missing"
 * into an explicit, reviewable plan and then execute it with live output.
 *
 * Rules this module keeps:
 *   - never `sudo`; everything lands in `~/.local` and `~/.dsh-remote`;
 *   - the plan is shown before anything runs, one row per step, so a user on a
 *     shared cluster can decline the Node step and keep "connect only";
 *   - mirrors are measured, not guessed: Node from the fastest of
 *     TUNA / nodejs.org / npmmirror, npm packages from the fastest of
 *     registry.npmjs.org / registry.npmmirror.com;
 *   - every command is independent: each one is a fresh ssh/wsl invocation, so
 *     state is carried through deterministic paths, never shell variables.
 * @module dsh-remote/bootstrap
 */

import { shellQuote } from './channel.js'
import { isSupportedNode } from './probe.js'

/** Candidate Node tarball mirrors, in the order they are reported. */
const NODE_MIRRORS = [
  { id: 'tuna', label: '清华 TUNA', base: 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release' },
  { id: 'npmmirror', label: 'npmmirror', base: 'https://registry.npmmirror.com/-/binary/node' },
  { id: 'nodejs', label: 'nodejs.org', base: 'https://nodejs.org/dist' },
]

/** Candidate npm registries. */
const NPM_REGISTRIES = [
  { id: 'npmjs', label: 'registry.npmjs.org', base: 'https://registry.npmjs.org' },
  { id: 'npmmirror', label: 'registry.npmmirror.com', base: 'https://registry.npmmirror.com' },
]

/** Approximate download sizes shown in the plan (MB). */
const SIZE_HINTS = { node: 32, dsh: 220 }

/** The `--prefix` every no-sudo install uses. */
const LOCAL_PREFIX = '$HOME/.local'

/** Map `uname -m` to the Node release arch slug. */
function nodeArch(arch) {
  return arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'x64'
}

/** A downloader invocation for the remote shell, or null when none exists. */
function downloader(caps) {
  if ((caps.curlPath ?? '') !== '') return 'curl'
  if ((caps.wgetPath ?? '') !== '') return 'wget'
  return null
}

/**
 * Script that prints the newest Node 22 release offered by the mirrors.
 * @returns {string} bash script printing `NODE_RELEASE=vX.Y.Z`.
 */
function resolveNodeVersionScript() {
  return String.raw`
try_url() {
  if command -v curl >/dev/null 2>&1; then curl -sS -m 25 -fL "$1" 2>/dev/null; else wget -q -O - --timeout=25 "$1" 2>/dev/null; fi
}
ver=$(try_url "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/" | grep -o 'v22\.[0-9][0-9]*\.[0-9][0-9]*' | sort -V | tail -n 1)
if [ -z "$ver" ]; then
  ver=$(try_url "https://nodejs.org/dist/index.tab" | awk '$1 ~ /^v22\.[0-9]+\.[0-9]+$/ {print $1; exit}')
fi
printf 'NODE_RELEASE=%s\n' "$ver"
`
}

/**
 * Script that measures download throughput of several URLs in parallel, with
 * a 4 second cap each. Without curl no measurement is possible and the mirror
 * choice falls back to the order the plan lists.
 * @param {Array<{id: string, url: string}>} targets - URLs to measure.
 * @returns {string} bash script printing `SPEED <id> <bytesPerSecond>` lines.
 */
function speedScript(targets) {
  const lines = targets.map(target => `measure ${shellQuote(target.id)} ${shellQuote(target.url)} &`).join('\n')
  return String.raw`
measure() {
  if command -v curl >/dev/null 2>&1; then
    value=$(curl -o /dev/null -sS -m 4 -w '%{speed_download}' "$2" 2>/dev/null || echo 0)
  else
    value=0
  fi
  printf 'SPEED %s %s\n' "$1" "$value"
}
${lines}
wait
`
}

/**
 * Build the install plan for one target.
 * @param {{channel: import('./channel.js').Channel, caps: Record<string, any>}} options - connector and probe caps.
 * @returns {Promise<{steps: Array<object>, mirrors: object, blocked?: string}>} plan.
 */
export async function buildPlan({ channel, caps }) {
  const steps = []
  const mirrors = { node: [], npm: [] }
  const nodeOk = typeof caps.nodeOk === 'boolean' ? caps.nodeOk : isSupportedNode(caps.nodeVersion)
  const dshOk = typeof caps.dshOk === 'boolean' ? caps.dshOk : (caps.dshPath ?? '') !== ''
  const fetchTool = downloader(caps)

  if (!nodeOk) {
    if (fetchTool === null) {
      return {
        steps: [],
        mirrors,
        blocked: '远程既没有 curl 也没有 wget，无法下载 Node。请先装其中一个（例如 `apt install curl`，需要管理员），或在远程手动装好 Node 22 后再点“探测”。',
      }
    }
    const releaseResult = await channel.exec(resolveNodeVersionScript(), { timeoutMs: 40000 })
    const version = /NODE_RELEASE=(v\d+\.\d+\.\d+)/.exec(releaseResult.stdout ?? '')?.[1]
    if (version === undefined) {
      return {
        steps: [],
        mirrors,
        blocked: '无法从镜像站确定 Node 22 的版本号（网络不可达或被防火墙拦截）。可以先在远程手动安装 Node 22，再回来点“探测”。',
      }
    }
    const arch = nodeArch(caps.arch)
    const urls = Object.fromEntries(NODE_MIRRORS.map(mirror => [
      mirror.id,
      `${mirror.base}/${version}/node-${version}-linux-${arch}.tar.gz`,
    ]))
    const measured = await channel.exec(
      speedScript(NODE_MIRRORS.map(mirror => ({ id: mirror.id, url: urls[mirror.id] }))),
      { timeoutMs: 25000 },
    )
    const speeds = parseSpeeds(measured.stdout)
    mirrors.node = NODE_MIRRORS.map(mirror => ({ ...mirror, url: urls[mirror.id], bytesPerSecond: speeds[mirror.id] ?? 0 }))
    const bestNode = pickFastest(mirrors.node, 'tuna')
    const tarball = `$HOME/.dsh-remote/node-${version}.tar.gz`
    const fetch = fetchTool === 'curl'
      ? `curl -fL --retry 2 --connect-timeout 15 -o ${tarball} ${shellQuote(bestNode?.url ?? urls.nodejs)}`
      : `wget -q --tries=2 --timeout=30 -O ${tarball} ${shellQuote(bestNode?.url ?? urls.nodejs)}`
    steps.push({
      id: 'node',
      version,
      title: `安装 Node ${version}`,
      detail: `下载自 ${bestNode?.label ?? 'nodejs.org'}，解压到 ${LOCAL_PREFIX}/node-${version}，软链为 ${LOCAL_PREFIX}/node。不使用 sudo，不改系统目录。`,
      path: `${LOCAL_PREFIX}/node-${version}`,
      sizeMB: SIZE_HINTS.node,
      required: true,
      source: bestNode?.label ?? 'nodejs.org',
      commands: [
        { label: '准备目录', script: `mkdir -p ${LOCAL_PREFIX} $HOME/.dsh-remote` },
        { label: `下载 Node ${version}`, script: fetch, stream: true },
        {
          label: '解包并切换版本',
          script: `mkdir -p ${LOCAL_PREFIX}/node-${version} && tar -xzf ${tarball} -C ${LOCAL_PREFIX}/node-${version} --strip-components=1 && ln -sfn ${LOCAL_PREFIX}/node-${version} ${LOCAL_PREFIX}/node && rm -f ${tarball} && ${LOCAL_PREFIX}/node/bin/node -v && ${LOCAL_PREFIX}/node/bin/npm -v`,
          stream: true,
        },
      ],
    })
  }

  if (!dshOk) {
    const npmTargets = NPM_REGISTRIES.map(registry => ({
      id: registry.id,
      url: `${registry.base}/typescript/-/typescript-5.6.3.tgz`,
    }))
    const measured = await channel.exec(speedScript(npmTargets), { timeoutMs: 25000 })
    const speeds = parseSpeeds(measured.stdout)
    mirrors.npm = NPM_REGISTRIES.map(registry => ({ ...registry, bytesPerSecond: speeds[registry.id] ?? 0 }))
    const bestNpm = pickFastest(mirrors.npm, 'npmjs')
    steps.push({
      id: 'dsh',
      title: '安装 dsh 命令行',
      detail: `npm i -g --prefix ${LOCAL_PREFIX} @deepseek-ai/dsh（registry: ${bestNpm?.label ?? 'registry.npmjs.org'}），可执行文件落在 ${LOCAL_PREFIX}/bin/dsh。`,
      path: `${LOCAL_PREFIX}/bin/dsh`,
      sizeMB: SIZE_HINTS.dsh,
      required: true,
      source: bestNpm?.label ?? 'registry.npmjs.org',
      registry: bestNpm?.base ?? 'https://registry.npmjs.org',
      commands: [
        {
          label: `从 ${bestNpm?.label ?? 'registry.npmjs.org'} 安装`,
          // Prefer the npm that ships with the Node installed in the step
          // above: on a WSL/Windows PATH a stray `npm` can resolve to a
          // mounted Windows launcher, which cannot run under Linux.
          script: `if [ -x "${LOCAL_PREFIX}/node/bin/npm" ]; then NPM="${LOCAL_PREFIX}/node/bin/npm"; else NPM="$(command -v npm)"; fi; "${'$'}NPM" i -g --prefix ${LOCAL_PREFIX} --registry ${bestNpm?.base ?? 'https://registry.npmjs.org'} --no-fund --no-audit @deepseek-ai/dsh`,
          stream: true,
        },
        { label: '验证版本', script: `${LOCAL_PREFIX}/bin/dsh --version` },
      ],
    })
  }

  if ((caps.tmuxPath ?? '') === '') {
    steps.push({
      id: 'tmux',
      title: 'tmux 未安装（可跳过）',
      detail: '没有 tmux 时改用 setsid + nohup 后台运行，远程 dsh 在本地断开后依然继续工作。',
      path: '—',
      sizeMB: 0,
      required: false,
      informational: true,
      commands: [],
    })
  }

  return { steps, mirrors }
}

/**
 * Parse `SPEED <id> <bytes>` lines.
 * @param {string} stdout - script output.
 * @returns {Record<string, number>} bytes per second per mirror id.
 */
export function parseSpeeds(stdout) {
  const speeds = {}
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^SPEED\s+(\S+)\s+([\d.]+)/.exec(line.trim())
    if (match === null) continue
    const value = Number.parseFloat(match[2])
    speeds[match[1]] = Number.isFinite(value) ? value : 0
  }
  return speeds
}

/**
 * Pick the fastest mirror, preferring the fallback when nothing measured.
 * @param {Array<{id: string, bytesPerSecond?: number}>} mirrors - candidates.
 * @param {string} fallbackId - id to use when all measurements are zero.
 * @returns {object | undefined} chosen mirror.
 */
export function pickFastest(mirrors, fallbackId) {
  const measured = mirrors.filter(mirror => (mirror.bytesPerSecond ?? 0) > 0)
  if (measured.length === 0) return mirrors.find(mirror => mirror.id === fallbackId) ?? mirrors[0]
  return measured.reduce((best, item) => ((item.bytesPerSecond ?? 0) > (best.bytesPerSecond ?? 0) ? item : best))
}

/**
 * Format a byte rate for display.
 * @param {number} bytesPerSecond - measured rate.
 * @returns {string} human-readable rate.
 */
export function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '未测出'
  const mb = bytesPerSecond / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
}

/**
 * Execute one planned step and stream its output.
 * @param {{channel: import('./channel.js').Channel, step: object, emit: (frame: object) => void, signal?: AbortSignal}} options - run context.
 * @returns {Promise<{ok: boolean, message?: string}>} step outcome.
 */
export async function runStep({ channel, step, emit, signal }) {
  emit({ type: 'step', step: step.id, phase: 'start', title: step.title })
  if (step.informational === true || (step.commands ?? []).length === 0) {
    emit({ type: 'step', step: step.id, phase: 'skip', message: step.detail })
    return { ok: true }
  }
  for (const command of step.commands) {
    if (signal?.aborted === true) {
      emit({ type: 'step', step: step.id, phase: 'fail', message: '已中止' })
      return { ok: false, message: '安装已中止' }
    }
    emit({ type: 'step', step: step.id, phase: 'command', command: command.label, script: command.script })
    const result = await channel.exec(command.script, {
      timeoutMs: command.stream === true ? 30 * 60 * 1000 : 120000,
      signal,
      onData: chunk => emit({ type: 'step', step: step.id, phase: 'log', chunk }),
    })
    if (command.stream !== true) {
      const clean = String(result.stdout ?? '').trim()
      if (clean !== '') emit({ type: 'step', step: step.id, phase: 'log', chunk: `${clean}\n` })
    }
    if (result.code !== 0) {
      const tail = tailLines(`${result.stderr ?? ''}\n${result.stdout ?? ''}`, 20)
      emit({ type: 'step', step: step.id, phase: 'fail', code: result.code, message: result.error ?? '' })
      return {
        ok: false,
        message: `${command.label} 失败（exit ${result.code}${result.timedOut ? '，超时' : ''}）。${tail === '' ? '' : `\n${tail}`}`,
      }
    }
  }
  emit({ type: 'step', step: step.id, phase: 'done' })
  return { ok: true }
}

/**
 * Keep the last N non-empty lines of a log.
 * @param {string} text - raw output.
 * @param {number} count - line budget.
 * @returns {string} tail.
 */
export function tailLines(text, count) {
  const lines = String(text ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.slice(-count).join('\n')
}
