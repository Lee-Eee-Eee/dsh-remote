/**
 * dsh-remote-dock — browser half.
 *
 * Registers two seats in the shell the same way the shipped panels do:
 *   - a row in `sidebar.panellist` (the "Remote" entry), whose id also
 *     addresses the center column;
 *   - the page in `main`, keyed by that id, so selecting the row switches the
 *     center column to the remote workspace.
 *
 * The page is a thin client over the host route family:
 *   GET  /api/dsh-remote/targets      list + discovery
 *   POST /api/dsh-remote/targets      create / patch / delete (?id=)
 *   POST /api/dsh-remote/discover     refresh ~/.ssh/config and WSL
 *   POST /api/dsh-remote/probe        (?id=) environment probe
 *   POST /api/dsh-remote/plan         (?id=) install plan
 *   POST /api/dsh-remote/bootstrap    (?id=) NDJSON install stream
 *   POST /api/dsh-remote/start|stop   (?id=)
 *   GET  /api/dsh-remote/status       (?id=) polling
 *
 * The remote DSH UI is embedded in an iframe pointed at the loopback tunnel.
 * That works because the remote index carries neither `X-Frame-Options` nor a
 * `frame-ancestors` policy, and because the tunnel presents the same
 * `127.0.0.1:<port>` authority the remote auth cookie was issued for.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-dock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/api/dsh-remote'
    const SELECTED_KEY = 'dsh-remote:selected'

    // ---------------------------------------------------------------- locale

    /** Translation dictionaries. */
    const DICTS = {
      zh: {
        'entry.label': '远程',
        'rail.title': '远程工作区',
        'rail.refresh': '刷新',
        'rail.add': '添加目标',
        'rail.empty': '还没有目标。下面是从 ~/.ssh/config 与 WSL 发现的主机。',
        'rail.discovered': '发现的主机',
        'rail.sshGroup': 'SSH（~/.ssh/config）',
        'rail.wslGroup': 'WSL 发行版',
        'rail.import': '添加',
        'rail.added': '已添加',
        'rail.none': '无',
        'rail.delete': '删除目标',
        'rail.confirmDelete': '删除目标“{label}”？远程已安装的 dsh 不会被卸载。',
        'state.idle': '未启动',
        'state.probing': '探测中…',
        'state.bootstrapping': '安装中…',
        'state.starting': '启动中…',
        'state.running': '已连接',
        'state.error': '失败',
        'empty.title': '选一个远程工作区',
        'empty.hint': '点左侧目标即可探测环境并连接。远程还没装 dsh 时，向导会用 npm 装到 ~/.local（不使用 sudo）。',
        'empty.pick': '从左边选择一个目标开始。',
        'main.connect': '连接',
        'main.reconnect': '重新连接',
        'main.stop': '停止远程',
        'main.restart': '重启',
        'main.probe': '探测环境',
        'main.install': '安装 dsh',
        'main.plan': '查看安装计划',
        'main.reload': '重载',
        'main.browser': '在浏览器打开',
        'main.copy': '复制地址',
        'main.copied': '地址已复制',
        'main.fullscreen': '全屏',
        'main.exitFullscreen': '退出全屏',
        'caps.os': '系统',
        'caps.node': 'Node',
        'caps.dsh': 'dsh',
        'caps.tmux': 'tmux',
        'caps.disk': '可用空间',
        'caps.cpus': 'CPU',
        'caps.fingerprint': '主机指纹',
        'caps.none': '未探测',
        'plan.title': '安装计划',
        'plan.nosudo': '不使用 sudo；所有文件落在 ~/.local 与 ~/.dsh-remote。',
        'plan.path': '安装位置',
        'plan.size': '约 {size} MB',
        'plan.source': '下载源',
        'plan.skip': '跳过',
        'plan.start': '开始安装',
        'plan.cancel': '取消',
        'plan.blocked': '无法自动安装',
        'log.title': '日志',
        'log.installing': '正在安装…',
        'log.done': '安装完成',
        'log.abort': '中止',
        'error.title': '出错了',
        'error.retryProbe': '重试探测',
        'error.openPlan': '打开安装计划',
        'form.title': '添加目标',
        'form.kindSsh': 'SSH 主机',
        'form.kindWsl': 'WSL 发行版',
        'form.alias': 'ssh 别名（~/.ssh/config）',
        'form.aliasHint': '填别名就沿用 ssh 的全部配置（跳板机、密钥、端口）',
        'form.host': '地址',
        'form.user': '用户',
        'form.port': '端口',
        'form.identity': '私钥路径',
        'form.label': '显示名称',
        'form.distro': '发行版名称',
        'form.save': '保存',
        'form.cancel': '取消',
        'form.required': '别名和地址至少填一个',
        'common.working': '处理中…',
        'remoteAlive': '远程仍在运行（隧道已断开），点“重新连接”即可恢复。',
        'sub.ssh': '{user}@{host}',
        'sub.wsl': 'WSL · {distro}',
        'cfg.needTitle': '远程还没有模型配置',
        'cfg.needHint': '远程 dsh 目前没有任何服务商，面板里无法对话。把本机的模型配置移植过去即可：只复制 llm-pi-ai 服务商、默认模型和 API 密钥，不会显示密钥内容。',
        'cfg.title': '移植本地配置',
        'cfg.hint': '从本机当前 profile 读取，写入远程 ~/.dsh（0600）。写入前自动备份为 *.bak-<时间>。',
        'cfg.open': '移植本地配置',
        'cfg.write': '写入远程',
        'cfg.writing': '正在写入…',
        'cfg.close': '关闭',
        'cfg.secret': '含密钥',
        'cfg.remoteHas': '远程已有 {n} 处服务商配置，移植会覆盖同名项。',
        'cfg.none': '本机没有可移植的模型配置。',
        'cfg.written': '已写入 {files}。备份：{backups}',
        'cfg.restartHint': '写入后需要重启远程 dsh 才会生效。',
        'cfg.apply': '写入并重启',
        'cfg.restarted': '已重启，配置已生效。',
        'hostMismatch.title': '远程绑定的主机名和当前页面不一致',
        'hostMismatch.body': '远程 dsh 用 {remote} 启动，而当前页面在 {page}。浏览器的登录 cookie 是 SameSite=Strict，两种写法算不同站点，所以会看到 401。点“重新连接”会按当前主机名重启远程。',
      },
      en: {
        'entry.label': 'Remote',
        'rail.title': 'Remote workspaces',
        'rail.refresh': 'Refresh',
        'rail.add': 'Add target',
        'rail.empty': 'No targets yet. Hosts found in ~/.ssh/config and WSL are listed below.',
        'rail.discovered': 'Discovered',
        'rail.sshGroup': 'SSH (~/.ssh/config)',
        'rail.wslGroup': 'WSL distributions',
        'rail.import': 'Add',
        'rail.added': 'Added',
        'rail.none': 'none',
        'rail.delete': 'Delete target',
        'rail.confirmDelete': 'Delete target "{label}"? The remote dsh installation is left untouched.',
        'state.idle': 'Not started',
        'state.probing': 'Probing…',
        'state.bootstrapping': 'Installing…',
        'state.starting': 'Starting…',
        'state.running': 'Connected',
        'state.error': 'Failed',
        'empty.title': 'Pick a remote workspace',
        'empty.hint': 'Select a target to probe it and connect. When dsh is missing, the wizard installs it into ~/.local with npm — no sudo.',
        'empty.pick': 'Select a target on the left to begin.',
        'main.connect': 'Connect',
        'main.reconnect': 'Reconnect',
        'main.stop': 'Stop remote',
        'main.restart': 'Restart',
        'main.probe': 'Probe',
        'main.install': 'Install dsh',
        'main.plan': 'Review install plan',
        'main.reload': 'Reload',
        'main.browser': 'Open in browser',
        'main.copy': 'Copy address',
        'main.copied': 'Address copied',
        'main.fullscreen': 'Fullscreen',
        'main.exitFullscreen': 'Exit fullscreen',
        'caps.os': 'OS',
        'caps.node': 'Node',
        'caps.dsh': 'dsh',
        'caps.tmux': 'tmux',
        'caps.disk': 'Free disk',
        'caps.cpus': 'CPUs',
        'caps.fingerprint': 'Host key',
        'caps.none': 'not probed',
        'plan.title': 'Install plan',
        'plan.nosudo': 'No sudo: everything lands in ~/.local and ~/.dsh-remote.',
        'plan.path': 'Installs to',
        'plan.size': '~{size} MB',
        'plan.source': 'Source',
        'plan.skip': 'Skip',
        'plan.start': 'Start install',
        'plan.cancel': 'Cancel',
        'plan.blocked': 'Cannot install automatically',
        'log.title': 'Log',
        'log.installing': 'Installing…',
        'log.done': 'Install finished',
        'log.abort': 'Abort',
        'error.title': 'Something failed',
        'error.retryProbe': 'Retry probe',
        'error.openPlan': 'Open install plan',
        'form.title': 'Add target',
        'form.kindSsh': 'SSH host',
        'form.kindWsl': 'WSL distribution',
        'form.alias': 'ssh alias (~/.ssh/config)',
        'form.aliasHint': 'An alias inherits everything ssh already knows: jump host, keys, port',
        'form.host': 'Address',
        'form.user': 'User',
        'form.port': 'Port',
        'form.identity': 'Private key path',
        'form.label': 'Display name',
        'form.distro': 'Distribution name',
        'form.save': 'Save',
        'form.cancel': 'Cancel',
        'form.required': 'Provide an alias or an address',
        'common.working': 'Working…',
        'remoteAlive': 'The remote is still running (tunnel closed). Reconnect to resume.',
        'sub.ssh': '{user}@{host}',
        'sub.wsl': 'WSL · {distro}',
        'cfg.needTitle': 'The remote has no model configuration',
        'cfg.needHint': 'The remote dsh has no provider yet, so the embedded UI cannot talk to a model. Port this machine\'s model configuration: only the llm-pi-ai providers, the default model and the API key refs are copied, and no key value is ever displayed.',
        'cfg.title': 'Port local configuration',
        'cfg.hint': 'Read from this machine\'s current profile and written to the remote ~/.dsh (0600). Existing files are backed up to *.bak-<timestamp> first.',
        'cfg.open': 'Port local config',
        'cfg.write': 'Write to remote',
        'cfg.writing': 'Writing…',
        'cfg.close': 'Close',
        'cfg.secret': 'secrets',
        'cfg.remoteHas': 'The remote already has {n} provider rows; porting overwrites the same names.',
        'cfg.none': 'This machine has no model configuration to port.',
        'cfg.written': 'Wrote {files}. Backups: {backups}',
        'cfg.restartHint': 'Restart the remote dsh for the new configuration to take effect.',
        'cfg.apply': 'Write and restart',
        'cfg.restarted': 'Restarted; the configuration is live.',
        'hostMismatch.title': 'The remote is bound to a different host name',
        'hostMismatch.body': 'The remote dsh was started as {remote} while this page runs on {page}. The auth cookie is SameSite=Strict, so the browser treats those as different sites and the iframe gets 401. Reconnecting restarts the remote under the current host name.',
      },
    }

    /** Live locale holder shared by every mounted component. */
    const localeStore = { value: 'zh', listeners: new Set() }

    /** Switch the active locale and notify mounted components. */
    function setActiveLocale(next) {
      if (localeStore.value === next) return
      localeStore.value = next
      for (const listener of localeStore.listeners) listener()
    }

    /** Normalize a locale id from the shell (`zh-CN` → `zh`). */
    function normalizeLocale(id) {
      const value = String(id ?? '').toLowerCase()
      if (value.startsWith('zh')) return 'zh'
      if (value === '') return 'zh'
      return 'en'
    }

    /** Translate one key with `{name}` interpolation. */
    function t(key, params) {
      const dict = DICTS[localeStore.value] ?? DICTS.en
      const template = dict[key] ?? DICTS.en[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (_all, name) => String(params[name] ?? ''))
    }

    /** Re-render on locale changes. */
    function useLocaleTick() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force(value => value + 1)
        localeStore.listeners.add(listener)
        return () => { localeStore.listeners.delete(listener) }
      }, [])
      return localeStore.value
    }

    // ------------------------------------------------------------------- api

    /** JSON request against the host route family. */
    async function api(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        parsed = null
      }
      if (!response.ok) {
        throw new Error(parsed?.error ?? `HTTP ${response.status}`)
      }
      return parsed
    }

    /** Read an NDJSON body frame by frame. */
    async function readNdjson(response, onFrame) {
      if (response.body === null) throw new Error('streaming unsupported')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line !== '') {
            try {
              onFrame(JSON.parse(line))
            } catch {
              /* a partial line: ignore */
            }
          }
          index = buffer.indexOf('\n')
        }
      }
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
      [data-dsh-remote-view] { display: flex; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
      .dr-rail { width: 268px; flex: 0 0 268px; display: flex; flex-direction: column; min-height: 0;
        border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .dr-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 12px 12px 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em;
        text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .dr-rail-body { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 12px; }
      .dr-rail-foot { padding: 8px 12px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dr-group { margin: 10px 2px 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dr-row { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
        padding: 7px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent;
        color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .dr-row:hover { background: var(--dsw-alias-bg-layer-2); }
      .dr-row[data-active='1'] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
      .dr-row-body { min-width: 0; flex: 1 1 auto; }
      .dr-row-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dr-row-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .dr-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
      .dr-dot[data-state='idle'] { background: var(--dsw-alias-state-idle-primary); }
      .dr-dot[data-state='running'] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
      .dr-dot[data-state='error'] { background: var(--dsw-alias-state-error-primary); }
      .dr-dot[data-state='probing'], .dr-dot[data-state='starting'], .dr-dot[data-state='bootstrapping'] {
        background: var(--dsw-alias-brand-primary); animation: dr-pulse 1.1s ease-in-out infinite; }
      @keyframes dr-pulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
      .dr-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .dr-pad { padding: 16px; overflow-y: auto; }
      .dr-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; margin-bottom: 12px; }
      .dr-card h3 { margin: 0 0 6px; font-size: 14px; }
      .dr-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .dr-caps { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 10px 0 0; }
      .dr-cap { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 9px; }
      .dr-cap-k { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dr-cap-v { font-size: 13px; overflow-wrap: anywhere; }
      .dr-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .dr-btn { font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: inherit; }
      .dr-btn:hover { border-color: var(--dsw-alias-brand-primary); }
      .dr-btn[data-kind='primary'] { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
      .dr-btn:disabled { opacity: .5; cursor: default; }
      .dr-btn[data-kind='ghost'] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); padding: 4px 6px; }
      .dr-btn[data-kind='ghost']:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
      .dr-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex: 0 0 auto; }
      .dr-toolbar-title { font-size: 13px; font-weight: 600; margin-right: auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dr-stage { flex: 1 1 auto; min-height: 0; background: var(--dsw-alias-bg-base); }
      .dr-frame { width: 100%; height: 100%; border: 0; display: block; background: var(--dsw-alias-bg-base); }
      .dr-main[data-expanded='1'] { position: fixed; inset: 0; z-index: 60; background: var(--dsw-alias-bg-base); }
      .dr-plan-row { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
      .dr-plan-head { display: flex; align-items: center; gap: 8px; }
      .dr-plan-title { font-size: 13px; font-weight: 600; flex: 1 1 auto; }
      .dr-plan-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dr-plan-cmd { margin-top: 6px; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px; background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 6px 8px; overflow-x: auto; white-space: pre; }
      .dr-log { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px; line-height: 1.5; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px; padding: 10px; max-height: 46vh; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
      .dr-error { color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; font-size: 12.5px; }
      .dr-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
      .dr-field label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dr-input { font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 7px;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: inherit; }
      .dr-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .dr-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
      .dr-spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2);
        border-top-color: var(--dsw-alias-brand-primary); animation: dr-spin .9s linear infinite; }
      @keyframes dr-spin { to { transform: rotate(360deg); } }
      .dr-emptywrap { display: flex; height: 100%; align-items: center; justify-content: center; padding: 24px; }
      .dr-empty { max-width: 420px; text-align: center; }
      .dr-empty h2 { font-size: 16px; margin: 0 0 8px; }
    `

    // -------------------------------------------------------------- fragments

    /** Status dot. */
    function Dot({ state }) {
      return h('span', { className: 'dr-dot', 'data-state': state, 'data-dsh-remote': 'dot' })
    }

    /** Human label for one state. */
    function stateLabel(target) {
      if (target.state === 'running') {
        return target.version === undefined ? t('state.running') : `${t('state.running')} · v${target.version.replace(/^v/, '')}`
      }
      if (target.state === 'idle' && target.remoteAlive === true) return t('remoteAlive')
      return t(`state.${target.state}`) ?? target.state
    }

    /** Secondary line: where this target points. */
    function targetSubline(target) {
      if (target.kind === 'wsl') return t('sub.wsl', { distro: target.wsl?.distro ?? '' })
      const ssh = target.ssh ?? {}
      if (ssh.alias !== undefined) return ssh.user === undefined ? ssh.alias : `${ssh.user}@${ssh.alias}`
      return t('sub.ssh', { user: ssh.user ?? '', host: ssh.hostName ?? '' })
    }

    /** One row in the rail. */
    function TargetRow({ target, active, onSelect, onDelete }) {
      return h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('button', {
          type: 'button',
          className: 'dr-row',
          'data-active': active ? '1' : '0',
          onClick: () => onSelect(target.id),
          title: targetSubline(target),
        },
          h(Dot, { state: target.state }),
          h('span', { className: 'dr-row-body' },
            h('div', { className: 'dr-row-title' }, target.label),
            h('div', { className: 'dr-row-sub' }, targetSubline(target)),
          ),
        ),
        h('button', {
          type: 'button',
          className: 'dr-btn',
          'data-kind': 'ghost',
          title: t('rail.delete'),
          onClick: (event) => { event.stopPropagation(); onDelete(target) },
        }, '×'),
      )
    }

    /** Add-target form. */
    function AddForm({ discovery, onCancel, onSaved }) {
      const [kind, setKind] = useState('ssh')
      const [alias, setAlias] = useState('')
      const [host, setHost] = useState('')
      const [user, setUser] = useState('')
      const [port, setPort] = useState('')
      const [identity, setIdentity] = useState('')
      const [distro, setDistro] = useState('')
      const [label, setLabel] = useState('')
      const [error, setError] = useState(undefined)
      const [saving, setSaving] = useState(false)

      const submit = async () => {
        setError(undefined)
        if (kind === 'ssh' && alias.trim() === '' && host.trim() === '') {
          setError(t('form.required'))
          return
        }
        if (kind === 'wsl' && distro.trim() === '') {
          setError(t('form.required'))
          return
        }
        setSaving(true)
        try {
          const payload = kind === 'ssh'
            ? {
              kind: 'ssh',
              label: label.trim() === '' ? undefined : label.trim(),
              ssh: {
                alias: alias.trim() === '' ? undefined : alias.trim(),
                hostName: host.trim() === '' ? undefined : host.trim(),
                user: user.trim() === '' ? undefined : user.trim(),
                port: port.trim() === '' ? undefined : Number(port.trim()),
                identityFile: identity.trim() === '' ? undefined : identity.trim(),
              },
            }
            : { kind: 'wsl', label: label.trim() === '' ? undefined : label.trim(), wsl: { distro: distro.trim() } }
          const created = await api('/targets', { method: 'POST', body: payload })
          onSaved(created.target)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setSaving(false)
        }
      }

      const field = (key, value, setValue, placeholder) => h('div', { className: 'dr-field' },
        h('label', null, key),
        h('input', { className: 'dr-input', value, placeholder, onChange: event => setValue(event.target.value) }),
      )

      return h('div', { className: 'dr-card' },
        h('h3', null, t('form.title')),
        h('div', { className: 'dr-actions', style: { marginTop: 0, marginBottom: 10 } },
          h('button', { type: 'button', className: 'dr-btn', 'data-kind': kind === 'ssh' ? 'primary' : undefined, onClick: () => setKind('ssh') }, t('form.kindSsh')),
          h('button', { type: 'button', className: 'dr-btn', 'data-kind': kind === 'wsl' ? 'primary' : undefined, onClick: () => setKind('wsl') }, t('form.kindWsl')),
        ),
        kind === 'ssh'
          ? h('div', null,
            field(t('form.alias'), alias, setAlias, (discovery.ssh[0]?.alias) ?? 'grid'),
            h('div', { className: 'dr-muted', style: { marginBottom: 8 } }, t('form.aliasHint')),
            field(t('form.host'), host, setHost, '10.0.0.12'),
            field(t('form.user'), user, setUser, 'lee'),
            field(t('form.port'), port, setPort, '22'),
            field(t('form.identity'), identity, setIdentity, '~/.ssh/id_ed25519'),
          )
          : h('div', null,
            field(t('form.distro'), distro, setDistro, discovery.wsl[0]?.name ?? 'Debian'),
          ),
        field(t('form.label'), label, setLabel, ''),
        error === undefined ? null : h('div', { className: 'dr-error' }, error),
        h('div', { className: 'dr-actions' },
          h('button', { type: 'button', className: 'dr-btn', 'data-kind': 'primary', disabled: saving, onClick: submit }, saving ? t('common.working') : t('form.save')),
          h('button', { type: 'button', className: 'dr-btn', onClick: onCancel }, t('form.cancel')),
        ),
      )
    }

    /** Capability grid. */
    function Caps({ target }) {
      const caps = target.caps
      if (caps === undefined) return h('div', { className: 'dr-muted' }, t('caps.none'))
      const rows = [
        [t('caps.os'), [caps.distro, caps.arch].filter(Boolean).join(' · ') || '—'],
        [t('caps.node'), caps.nodeVersion ?? '—'],
        [t('caps.dsh'), caps.dshVersion ?? '—'],
        [t('caps.tmux'), caps.tmuxPath === undefined || caps.tmuxPath === '' ? '—' : caps.tmuxPath],
        [t('caps.disk'), caps.diskFreeGB === undefined ? '—' : `${caps.diskFreeGB} GB`],
        [t('caps.cpus'), caps.cpus === undefined ? '—' : String(caps.cpus)],
      ]
      if (target.fingerprint !== undefined) rows.push([t('caps.fingerprint'), target.fingerprint])
      return h('div', { className: 'dr-caps' }, rows.map(([key, value]) => h('div', { className: 'dr-cap', key },
        h('div', { className: 'dr-cap-k' }, key),
        h('div', { className: 'dr-cap-v', title: String(value) }, String(value)),
      )))
    }

    /** Install plan review card. */
    function PlanCard({ plan, skip, onToggleSkip, onStart, onCancel, running }) {
      if (plan.blocked !== undefined && plan.blocked !== null) {
        return h('div', { className: 'dr-card' },
          h('h3', null, t('plan.blocked')),
          h('div', { className: 'dr-error' }, plan.blocked),
          h('div', { className: 'dr-actions' }, h('button', { type: 'button', className: 'dr-btn', onClick: onCancel }, t('form.cancel'))),
        )
      }
      return h('div', { className: 'dr-card' },
        h('h3', null, t('plan.title')),
        h('div', { className: 'dr-muted' }, t('plan.nosudo')),
        (plan.mirrors?.node ?? []).length > 0
          ? h('div', { className: 'dr-note' }, `Node: ${plan.mirrors.node.map(mirror => `${mirror.label} ${mirror.rate}`).join(' · ')}`)
          : null,
        (plan.mirrors?.npm ?? []).length > 0
          ? h('div', { className: 'dr-note' }, `npm: ${plan.mirrors.npm.map(mirror => `${mirror.label} ${mirror.rate}`).join(' · ')}`)
          : null,
        h('div', { style: { marginTop: 12 } }, plan.steps.map(step => {
          const skipped = skip.has(step.id)
          return h('div', { className: 'dr-plan-row', key: step.id, style: skipped ? { opacity: 0.55 } : undefined },
            h('div', { className: 'dr-plan-head' },
              h('span', { className: 'dr-plan-title' }, step.title),
              step.required === true && step.informational !== true
                ? h('label', { className: 'dr-muted', style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', { type: 'checkbox', checked: skipped, onChange: () => onToggleSkip(step.id) }),
                  t('plan.skip'))
                : h('span', { className: 'dr-badge' }, 'info'),
            ),
            h('div', { className: 'dr-muted', style: { marginTop: 4 } }, step.detail),
            h('div', { className: 'dr-plan-meta' },
              h('span', null, `${t('plan.path')}: ${step.path}`),
              step.sizeMB > 0 ? h('span', null, t('plan.size', { size: step.sizeMB })) : null,
              step.source === undefined ? null : h('span', null, `${t('plan.source')}: ${step.source}`),
            ),
            (step.commands ?? []).length === 0 ? null : h('div', { className: 'dr-plan-cmd' }, step.commands.map(command => `$ ${command.script}`).join('\n')),
          )
        })),
        h('div', { className: 'dr-actions' },
          h('button', { type: 'button', className: 'dr-btn', 'data-kind': 'primary', disabled: running, onClick: onStart }, running ? t('common.working') : t('plan.start')),
          h('button', { type: 'button', className: 'dr-btn', disabled: running, onClick: onCancel }, t('plan.cancel')),
        ),
      )
    }

    /**
     * Configuration port review: what will be copied, with secret values
     * represented only by their key names.
     */
    function ConfigCard({ preview, selected, onToggle, onApply, onClose, busy, result, running }) {
      if (preview === undefined || preview === null) return null
      const items = preview.items ?? []
      return h('div', { className: 'dr-card' },
        h('h3', null, t('cfg.title')),
        h('div', { className: 'dr-muted' }, t('cfg.hint')),
        h('div', { className: 'dr-note' },
          preview.remote?.needsConfig === false
            ? t('cfg.remoteHas', { n: preview.remote?.providerCount ?? 0 })
            : t('cfg.needHint')),
        h('div', { style: { marginTop: 10 } }, items.map(item => h('label', {
          key: item.id,
          className: 'dr-plan-row',
          style: { display: 'flex', gap: 9, alignItems: 'flex-start', opacity: item.present === true ? 1 : 0.5 },
        },
          h('input', {
            type: 'checkbox',
            checked: selected.has(item.id),
            disabled: item.present !== true || busy,
            onChange: () => onToggle(item.id),
          }),
          h('span', { style: { minWidth: 0 } },
            h('div', { className: 'dr-plan-title' },
              item.title,
              item.secret === true ? h('span', { className: 'dr-badge', style: { marginLeft: 8 } }, t('cfg.secret')) : null,
            ),
            h('div', { className: 'dr-muted' }, item.detail),
          ),
        ))),
        preview.hasAny === false ? h('div', { className: 'dr-note' }, t('cfg.none')) : null,
        running ? h('div', { className: 'dr-note' }, t('cfg.restartHint')) : null,
        result === undefined ? null : h('div', { className: 'dr-note' }, result),
        h('div', { className: 'dr-actions' },
          h('button', {
            type: 'button',
            className: 'dr-btn',
            'data-kind': 'primary',
            disabled: busy || selected.size === 0,
            onClick: onApply,
          }, busy ? t('cfg.writing') : t('cfg.apply')),
          h('button', { type: 'button', className: 'dr-btn', disabled: busy, onClick: onClose }, t('cfg.close')),
        ),
      )
    }

    /** Streaming log panel. */
    function LogPanel({ lines, running, onAbort }) {      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [lines.length])
      return h('div', { className: 'dr-card' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('h3', { style: { margin: 0, flex: '1 1 auto' } }, t('log.title')),
          running ? h('span', { className: 'dr-spinner' }) : null,
          running ? h('button', { type: 'button', className: 'dr-btn', onClick: onAbort }, t('log.abort')) : null,
        ),
        h('pre', { className: 'dr-log', ref }, lines.join('')),
      )
    }

    // ------------------------------------------------------------ remote page

    /** One remote workspace: rail + detail pane. */
    function RemotePage() {
      useLocaleTick()
      const [data, setData] = useState({ targets: [], discovery: { ssh: [], wsl: [] } })
      const [selectedId, setSelectedId] = useState(() => {
        try {
          return window.localStorage.getItem(SELECTED_KEY) ?? undefined
        } catch {
          return undefined
        }
      })
      const [adding, setAdding] = useState(false)
      const [plan, setPlan] = useState(undefined)
      const [skip, setSkip] = useState(() => new Set())
      const [logs, setLogs] = useState([])
      const [installing, setInstalling] = useState(false)
      const [notice, setNotice] = useState(undefined)
      const [configPreview, setConfigPreview] = useState(undefined)
      const [configSelected, setConfigSelected] = useState(() => new Set())
      const [configBusy, setConfigBusy] = useState(false)
      const [configResult, setConfigResult] = useState(undefined)
      const [frameKey, setFrameKey] = useState(0)
      const [expanded, setExpanded] = useState(false)
      const abortRef = useRef(null)

      const selected = useMemo(
        () => data.targets.find(target => target.id === selectedId) ?? data.targets[0],
        [data.targets, selectedId],
      )
      const effectiveId = selected?.id

      const refresh = useCallback(async (options = {}) => {
        try {
          const next = await api(`/targets${options.all === true ? '?refresh=1' : ''}`)
          setData(next)
          return next
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
          return undefined
        }
      }, [])

      useEffect(() => { refresh({ all: true }) }, [refresh])

      // Report the page origin to the host once per mount: the remote's auth
      // cookie is SameSite=Strict, so whether the iframe can authenticate at
      // all depends on the site this page runs on.
      useEffect(() => {
        api('/client-report', {
          method: 'POST',
          body: {
            origin: window.location.origin,
            host: window.location.hostname,
            href: window.location.href.split('?')[0],
            userAgent: navigator.userAgent,
          },
        }).catch(() => {})
      }, [])

      useEffect(() => {
        const timer = setInterval(() => { refresh() }, 2500)
        return () => clearInterval(timer)
      }, [refresh])

      useEffect(() => {
        if (effectiveId === undefined) return
        try {
          window.localStorage.setItem(SELECTED_KEY, effectiveId)
        } catch {
          /* private mode */
        }
      }, [effectiveId])

      // A target that becomes busy elsewhere (install started in another tab)
      // resets the wizard surfaces.
      useEffect(() => {
        if (selected === undefined) return
        if (selected.state === 'idle' && installing) {
          setInstalling(false)
        }
      }, [selected?.state, installing])

      const runProbe = async () => {
        if (selected === undefined) return
        setNotice(undefined)
        try {
          await api(`/probe?id=${encodeURIComponent(selected.id)}`, { method: 'POST' })
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
        refresh()
      }

      /** Load the configuration-port preview for one target and open the card. */
      const loadConfigPreview = async (id) => {
        const result = await api(`/local-config?id=${encodeURIComponent(id)}`)
        const preview = result.config
        setConfigPreview(preview)
        setConfigSelected(new Set((preview.items ?? []).filter(item => item.present === true && item.defaultOn === true).map(item => item.id)))
        return preview
      }

      const openConfig = async () => {
        if (selected === undefined) return
        setConfigResult(undefined)
        setConfigPreview(null)
        try {
          await loadConfigPreview(selected.id)
        } catch (error) {
          setConfigPreview(undefined)
          setNotice(error instanceof Error ? error.message : String(error))
        }
      }

      const applyConfig = async () => {
        if (selected === undefined) return
        setConfigBusy(true)
        setConfigResult(undefined)
        try {
          const result = await api(`/sync-config?id=${encodeURIComponent(selected.id)}&host=${encodeURIComponent(window.location.hostname)}`, {
            method: 'POST',
            body: { items: [...configSelected], restart: selected.state === 'running' },
          })
          const files = (result.wrote ?? []).join(', ')
          const backups = (result.backups ?? []).length
          setConfigResult(result.restarted === true
            ? `${t('cfg.written', { files, backups })}\n${t('cfg.restarted')}`
            : t('cfg.written', { files, backups }))
        } catch (error) {
          setConfigResult(error instanceof Error ? error.message : String(error))
        } finally {
          setConfigBusy(false)
          await refresh()
        }
      }

      const openPlan = async () => {        if (selected === undefined) return
        setNotice(undefined)
        setPlan(null)
        try {
          const result = await api(`/plan?id=${encodeURIComponent(selected.id)}`, { method: 'POST' })
          setSkip(new Set())
          setPlan(result.plan)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
          setPlan(undefined)
        }
      }

      const startInstall = async () => {
        if (selected === undefined || plan === null || plan === undefined) return
        setInstalling(true)
        setLogs([])
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const response = await fetch(`${API}/bootstrap?id=${encodeURIComponent(selected.id)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ skip: [...skip] }),
            signal: controller.signal,
          })
          if (!response.ok) {
            const text = await response.text()
            throw new Error(text === '' ? `HTTP ${response.status}` : text)
          }
          await readNdjson(response, (frame) => {
            if (frame.type === 'phase') setLogs(previous => [...previous, `\n== ${frame.message}\n`])
            if (frame.type === 'plan') {
              setLogs(previous => [...previous, '\n== 安装计划 ==\n'])
            }
            if (frame.type === 'step') {
              if (frame.phase === 'start') setLogs(previous => [...previous, `\n--> ${frame.title}\n`])
              if (frame.phase === 'command') setLogs(previous => [...previous, `$ ${frame.script}\n`])
              if (frame.phase === 'log') setLogs(previous => [...previous, frame.chunk ?? ''])
              if (frame.phase === 'done') setLogs(previous => [...previous, '✓ done\n'])
              if (frame.phase === 'skip') setLogs(previous => [...previous, `- skipped: ${frame.message ?? ''}\n`])
              if (frame.phase === 'fail') setLogs(previous => [...previous, `\n✗ failed (${frame.code ?? '?'}) ${frame.message ?? ''}\n`])
            }
            if (frame.type === 'error') setLogs(previous => [...previous, `\n✗ ${frame.message}\n`])
            if (frame.type === 'done') setLogs(previous => [...previous, `\n== ${frame.message ?? t('log.done')} ==\n`])
          })
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            setLogs(previous => [...previous, `\n✗ ${error instanceof Error ? error.message : String(error)}\n`])
          }
        } finally {
          abortRef.current = null
          setInstalling(false)
          const next = await refresh()
          // Auto-configure: a freshly bootstrapped remote has no providers, so
          // the embedded UI would open onto a configuration error. Open the
          // port card right away so one click makes the remote usable.
          const current = next?.targets?.find(target => target.id === selected.id)
          if (current?.caps?.needsConfig === true && current?.caps?.dshOk === true) {
            try {
              await loadConfigPreview(selected.id)
            } catch {
              /* the card stays closed; the 配置 button can retry */
            }
          }
        }
      }

      const start = async () => {
        if (selected === undefined) return
        setNotice(undefined)
        try {
          // The remote must advertise exactly the host this page is on: its
          // auth cookie is SameSite=Strict, and `localhost` vs `127.0.0.1`
          // counts as two different sites in a browser.
          await api(`/start?id=${encodeURIComponent(selected.id)}&host=${encodeURIComponent(window.location.hostname)}`, { method: 'POST' })
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
        await refresh()
      }

      /** Restart the remote dsh in place (stop + start, same registry entry). */
      const restart = async () => {
        if (selected === undefined) return
        setNotice(undefined)
        const host = encodeURIComponent(window.location.hostname)
        try {
          await api(`/restart?id=${encodeURIComponent(selected.id)}&host=${host}`, { method: 'POST' })
        } catch (error) {
          // Older host halves may not expose /restart yet; stopping and starting
          // is the same thing and both endpoints are older than this panel.
          try {
            await api(`/stop?id=${encodeURIComponent(selected.id)}`, { method: 'POST' })
            await api(`/start?id=${encodeURIComponent(selected.id)}&host=${host}`, { method: 'POST' })
          } catch (fallbackError) {
            setNotice(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
          }
        }
        await refresh()
      }

      const stop = async () => {
        if (selected === undefined) return
        if (!window.confirm(`${t('main.stop')} — ${selected.label}?`)) return
        try {
          await api(`/stop?id=${encodeURIComponent(selected.id)}`, { method: 'POST' })
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
        setPlan(undefined)
        setLogs([])
        await refresh()
      }

      const removeTarget = async (target) => {
        if (!window.confirm(t('rail.confirmDelete', { label: target.label }))) return
        try {
          await api(`/targets?id=${encodeURIComponent(target.id)}`, { method: 'DELETE' })
          if (target.id === effectiveId) setPlan(undefined)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
        await refresh()
      }

      const importTarget = async (entry) => {
        try {
          if (entry.kind === 'ssh') {
            await api('/targets', {
              method: 'POST',
              body: { kind: 'ssh', label: entry.host.alias, ssh: { alias: entry.host.alias } },
            })
          } else {
            await api('/targets', {
              method: 'POST',
              body: { kind: 'wsl', label: entry.distro.name, wsl: { distro: entry.distro.name } },
            })
          }
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
        await refresh()
      }

      // ------------------------------------------------------------- rail

      const rail = h('aside', { className: 'dr-rail' },
        h('div', { className: 'dr-rail-head' },
          h('span', null, t('rail.title')),
          h('button', {
            type: 'button', className: 'dr-btn', 'data-kind': 'ghost', title: t('rail.refresh'),
            onClick: () => refresh({ all: true }),
          }, '⟳'),
        ),
        h('div', { className: 'dr-rail-body' },
          data.targets.length === 0
            ? h('div', { className: 'dr-muted', style: { padding: '6px 8px' } }, t('rail.empty'))
            : data.targets.map(target => h(TargetRow, {
              key: target.id,
              target,
              active: target.id === effectiveId,
              onSelect: (id) => { setSelectedId(id); setPlan(undefined); setLogs([]) },
              onDelete: removeTarget,
            })),
          h('div', { className: 'dr-group' }, t('rail.discovered')),
          h('div', { className: 'dr-group', style: { marginTop: 8, opacity: .9 } }, t('rail.sshGroup')),
          data.discovery.ssh.length === 0
            ? h('div', { className: 'dr-muted', style: { padding: '2px 8px' } }, data.discovery.sshError ?? t('rail.none'))
            : data.discovery.ssh.map(host => h('div', { className: 'dr-row', key: `ssh-${host.alias}`, style: { cursor: 'default' } },
              h('span', { className: 'dr-row-body' },
                h('div', { className: 'dr-row-title' }, host.alias),
                h('div', { className: 'dr-row-sub' }, [host.user, host.hostName ?? host.alias, host.port].filter(Boolean).join(' · ')),
              ),
              host.added
                ? h('span', { className: 'dr-badge' }, t('rail.added'))
                : h('button', {
                  type: 'button', className: 'dr-btn', 'data-kind': 'ghost',
                  onClick: () => importTarget({ kind: 'ssh', host }),
                }, '+'),
            )),
          h('div', { className: 'dr-group', style: { marginTop: 8, opacity: .9 } }, t('rail.wslGroup')),
          data.discovery.wsl.length === 0
            ? h('div', { className: 'dr-muted', style: { padding: '2px 8px' } }, data.discovery.wslError ?? t('rail.none'))
            : data.discovery.wsl.map(distro => h('div', { className: 'dr-row', key: `wsl-${distro.name}`, style: { cursor: 'default' } },
              h('span', { className: 'dr-row-body' },
                h('div', { className: 'dr-row-title' }, distro.name),
                h('div', { className: 'dr-row-sub' }, `WSL ${distro.version} · ${distro.state}`),
              ),
              distro.added
                ? h('span', { className: 'dr-badge' }, t('rail.added'))
                : h('button', {
                  type: 'button', className: 'dr-btn', 'data-kind': 'ghost',
                  onClick: () => importTarget({ kind: 'wsl', distro }),
                }, '+'),
            )),
        ),
        h('div', { className: 'dr-rail-foot' },
          adding
            ? null
            : h('button', { type: 'button', className: 'dr-btn', style: { width: '100%' }, onClick: () => setAdding(true) }, `+ ${t('rail.add')}`),
          adding
            ? h(AddForm, {
              discovery: data.discovery,
              onCancel: () => setAdding(false),
              onSaved: async (target) => {
                setAdding(false)
                setSelectedId(target.id)
                await refresh()
              },
            })
            : null,
        ),
      )

      // ------------------------------------------------------------- detail

      let detail
      if (selected === undefined) {
        detail = h('div', { className: 'dr-pad' },
          h('div', { className: 'dr-card' }, h('h3', null, t('empty.title')), h('div', { className: 'dr-muted' }, t('empty.hint'))),
        )
      } else if (selected.state === 'running' && selected.url !== undefined) {
        let embeddedHost = ''
        try {
          embeddedHost = new URL(selected.url).host
        } catch {
          embeddedHost = selected.url
        }
        detail = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          h('div', { className: 'dr-toolbar' },
            h('div', { className: 'dr-toolbar-title' },
              h(Dot, { state: 'running' }),
              h('span', null, selected.label),
              h('span', { className: 'dr-muted' }, selected.version === undefined ? '' : `v${selected.version.replace(/^v/, '')}`),
              h('span', { className: 'dr-muted' }, embeddedHost),
            ),
            h('button', { type: 'button', className: 'dr-btn', onClick: () => setFrameKey(key => key + 1) }, t('main.reload')),
            h('button', { type: 'button', className: 'dr-btn', onClick: () => window.open(selected.url, '_blank', 'noopener') }, t('main.browser')),
            h('button', {
              type: 'button',
              className: 'dr-btn',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(selected.url)
                  setNotice(t('main.copied'))
                } catch {
                  setNotice(selected.url)
                }
              },
            }, t('main.copy')),
            h('button', { type: 'button', className: 'dr-btn', onClick: () => setExpanded(value => !value) }, t(expanded ? 'main.exitFullscreen' : 'main.fullscreen')),
            h('button', { type: 'button', className: 'dr-btn', onClick: restart }, t('main.restart')),
            h('button', { type: 'button', className: 'dr-btn', onClick: stop }, t('main.stop')),
          ),
          h('div', { className: 'dr-stage' },
            h('iframe', {
              key: `${selected.id}-${frameKey}`,
              className: 'dr-frame',
              src: selected.url,
                title: `DSH · ${selected.label}`,
                allow: 'clipboard-read; clipboard-write; fullscreen',
              }),
          ),
        )
      } else {
        const busy = selected.state === 'probing' || selected.state === 'starting' || selected.state === 'bootstrapping'
        const caps = selected.caps
        const needsInstall = caps !== undefined && (caps.nodeOk !== true || caps.dshOk !== true)
        detail = h('div', { className: 'dr-pad' },
          notice === undefined ? null : h('div', { className: 'dr-card' }, h('div', { className: 'dr-muted' }, notice)),
          h('div', { className: 'dr-card' },
            h('h3', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Dot, { state: selected.state }),
              h('span', null, selected.label),
              busy ? h('span', { className: 'dr-spinner' }) : null,
            ),
            h('div', { className: 'dr-muted' }, selected.phase ?? stateLabel(selected)),
            h('div', { className: 'dr-muted' }, targetSubline(selected)),
            h(Caps, { target: selected }),
            h('div', { className: 'dr-actions' },
              h('button', { type: 'button', className: 'dr-btn', disabled: busy, onClick: runProbe }, t('main.probe')),
              h('button', { type: 'button', className: 'dr-btn', 'data-kind': 'primary', disabled: busy, onClick: start }, selected.state === 'idle' && selected.remoteAlive === true ? t('main.reconnect') : t('main.connect')),
              needsInstall ? h('button', { type: 'button', className: 'dr-btn', disabled: busy, onClick: openPlan }, t('main.plan')) : null,
              h('button', { type: 'button', className: 'dr-btn', disabled: busy, onClick: openConfig }, t('cfg.open')),
              selected.state === 'error' ? h('button', { type: 'button', className: 'dr-btn', onClick: openPlan }, t('error.openPlan')) : null,
            ),
          ),
          selected.caps?.needsConfig === true && selected.caps?.dshOk === true && configPreview === undefined
            ? h('div', { className: 'dr-card', style: { borderColor: 'var(--dsw-alias-state-warn-primary)' } },
              h('h3', null, t('cfg.needTitle')),
              h('div', { className: 'dr-muted' }, t('cfg.needHint')),
              h('div', { className: 'dr-actions' },
                h('button', { type: 'button', className: 'dr-btn', 'data-kind': 'primary', onClick: openConfig }, t('cfg.open')),
              ),
            )
            : null,
          configPreview === null ? h('div', { className: 'dr-card' }, h('div', { className: 'dr-muted' }, t('common.working'))) : null,
          configPreview === null || configPreview === undefined
            ? null
            : h(ConfigCard, {
              preview: configPreview,
              selected: configSelected,
              busy: configBusy,
              result: configResult,
              running: selected.state === 'running',
              onToggle: (id) => {
                setConfigSelected(previous => {
                  const next = new Set(previous)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              },
              onApply: applyConfig,
              onClose: () => { setConfigPreview(undefined); setConfigResult(undefined) },
            }),
          selected.state === 'error' && selected.lastError !== undefined
            ? h('div', { className: 'dr-card' },
              h('h3', null, t('error.title')),
              h('div', { className: 'dr-error' }, selected.lastError),
              h('div', { className: 'dr-actions' },
                h('button', { type: 'button', className: 'dr-btn', onClick: runProbe }, t('error.retryProbe')),
              ),
            )
            : null,
          plan === undefined
            ? null
            : h(PlanCard, {
              plan,
              skip,
              running: installing,
              onToggleSkip: (id) => {
                setSkip(previous => {
                  const next = new Set(previous)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              },
              onStart: startInstall,
              onCancel: () => { setPlan(undefined); setLogs([]) },
            }),
          logs.length === 0
            ? null
            : h(LogPanel, {
              lines: logs,
              running: installing,
              onAbort: () => abortRef.current?.abort(),
            }),
        )
      }

      return h('div', { 'data-dsh-remote-view': '', className: 'dr-main-wrap', style: { display: 'flex', height: '100%', minHeight: 0, width: '100%' } },
        h('style', null, CSS),
        expanded ? null : rail,
        h('section', { className: 'dr-main', 'data-expanded': expanded ? '1' : '0' }, detail),
      )
    }

    // --------------------------------------------------------------- entry

    /** Sidebar glyph: a monitor with an uplink arrow. */
    function RemoteIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        'data-dsh-remote-icon': '',
      },
        h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 8.75, rx: 1.6 }),
        h('path', { d: 'M8 11.5v2' }),
        h('path', { d: 'M5.6 14h4.8' }),
        h('path', { d: 'M4.4 7.1h4.6' }),
        h('path', { d: 'M7.2 5.3l1.8 1.8-1.8 1.8' }),
        h('circle', { cx: 11.4, cy: 7.1, r: 1.15, fill: 'currentColor', stroke: 'none' }),
      )
    }

    const NS = 'dsh-remote-dock'

    return {
      inject: ['slots'],
      apply(ctx) {
        // Locale: register dictionaries and follow the shell's language.
        try {
          ctx.locale.register(NS, { zh: DICTS.zh, en: DICTS.en })
        } catch {
          /* locale plugin absent: keep the local fallback */
        }
        try {
          const snapshot = ctx.locale.getSnapshot?.() ?? ctx.locale.getLocale?.()
          const id = snapshot?.locale ?? snapshot?.id ?? snapshot?.active ?? snapshot?.language
          if (typeof id === 'string') setActiveLocale(normalizeLocale(id))
          else if (typeof navigator !== 'undefined') setActiveLocale(normalizeLocale(navigator.language))
          const dispose = ctx.locale.subscribe?.(() => {
            const next = ctx.locale.getSnapshot?.() ?? ctx.locale.getLocale?.()
            const nextId = next?.locale ?? next?.id ?? next?.active ?? next?.language
            if (typeof nextId === 'string') setActiveLocale(normalizeLocale(nextId))
          })
          if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-remote-dock: locale binding')
        } catch {
          try {
            if (typeof navigator !== 'undefined') setActiveLocale(normalizeLocale(navigator.language))
          } catch {
            /* no navigator: default stays */
          }
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'remote',
          order: 45,
          label: () => t('entry.label'),
        }, RemoteIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'remote',
          inject: () => ({}),
        }, RemotePage))
      },
    }
  },
})
