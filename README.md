# dsh-remote · 远程工作区

把**任何 SSH 主机或 WSL 发行版变成 DSH 工作区**：侧栏点一下「远程」，选目标 → 探测 → 装环境 → 移植配置 → 连接，远程 DSH 的完整界面就出现在本地 DSH 的面板里。

[English](README.en.md) · [许可证 MIT](LICENSE)

![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-blue) ![Node](https://img.shields.io/badge/Node-%5E22.19%20%7C%7C%20%3E%3D24-green) ![License](https://img.shields.io/badge/license-MIT-informational) ![CI](https://github.com/Lee-Eee-Eee/dsh-remote/actions/workflows/ci.yml/badge.svg)

> 尚未发布到 npm。安装方式见下文「安装」。

---

## 它解决什么

本地轻薄本、算力在服务器上。以前要把 DSH 跑在服务器上，得装 Node、配镜像、`npm i -g dsh`、配 key、起 tmux、拿 token、开隧道——四十分钟，每一步都能劝退。

`dsh-remote` 把这些压成一次点击，并且**远程 DSH 的界面就嵌在本地 DSH 里**（`sidebar.panellist` 的「远程」入口 + 主区页面），不需要另开浏览器窗口，不需要记住 token，不需要自己维护隧道。

## 使用流程

1. 侧栏点 **远程**。首次打开会自动列出 `~/.ssh/config` 里的主机（跳过含 `*` 的通配条）和 `wsl.exe -l -v` 里的发行版。
2. 点某个主机旁的 `+` 加入列表，或「添加目标」手填（别名 / 地址 / 用户 / 端口 / 私钥）。
3. 点目标 → **探测环境**：3 秒内显示系统、架构、Node、dsh、tmux、可用空间、主机指纹。
4. 缺 Node / dsh → **查看安装计划**：逐条列出将执行的命令、安装路径、体积、下载源（先测速再选镜像），可逐项取消；确认后实时输出日志。
5. 装完自动提示 **移植本地配置**：把本机的 `llm-pi-ai` 服务商、默认模型、API key 引用写到远程，远程 dsh 立刻可用。
6. **连接** → 面板里出现远程 DSH 完整界面，可对话、执行命令、改文件。
7. **停止远程** 结束远程进程；直接关面板或重启本地 DSH 不会杀掉远程 dsh，再点「重新连接」十秒内恢复。

## 面板里有什么

- **左侧栏**：已保存目标（状态点：灰=未启动 / 蓝转=忙 / 绿=已连接 / 红=失败）、从 ssh config 与 WSL 发现的主机、添加目标表单。
- **右侧主区**：能力表、安装计划、实时安装日志、配置移植清单、出错卡片（带下一步动作）。
- **连接后**：工具栏（重载 / 在浏览器打开 / 复制地址 / 全屏 / 重启 / 停止）+ 远程界面 iframe，标题旁显示版本与端口。

## 安装

```bash
# 1) 拿到源码
git clone git@github.com:Lee-Eee-Eee/dsh-remote.git
cd dsh-remote

# 2) 装进某个 profile（本仓库本身就是一个 DSH bundle，无需构建）
dsh plugin --profile desktop add "$PWD"
```

也可以在 DSH 的插件管理器里把**这个目录**作为 bundle 安装（`install_bundle` 的 target 传目录路径）。

`package.json` 自带 `dsh.bundle.patch` 与 `dsh.client`，安装后会插入 `id: remote` 的 host 行，并在页面里注册侧栏入口与主区页面。宿主侧插件 id 为 `remote`，客户端入口 id 亦为 `remote`。

> 安装或改完代码后：**重启 DSH**（宿主侧路由要重新加载），再**刷新页面**（浏览器侧模块要重新拉取）。面板本身不依赖重启，但新的 `/api/dsh-remote/*` 端点需要。

## 数据与文件

| 位置 | 内容 |
|---|---|
| `~/.dsh/dsh-remote.json`（0600） | 目标列表。token、端口、隧道都只在内存里 |
| 远程 `~/.dsh-remote/<id>.log` | 远程 dsh 的 stdout（每个目标一个文件，避免多实例互相覆盖） |
| 远程 `~/.local/node-<ver>` `/ ~/.local/bin/dsh` | 免 sudo 安装的 Node 与 dsh |
| 远程 `~/.dsh/profiles/web/cordis.patch.yml` | 移植过去时写入的 `llm-pi-ai` / `agent-default-model` 行 |
| 远程 `~/.dsh/.credentials.yaml`（0600） | 移植过去时合并的 `refs`（API key） |

写入远端配置前，原文件会被复制成 `*.bak-<时间戳>`。

## 关键设计（与直觉不同的地方）

**1. 用本机 OpenSSH 客户端，而不是内置 ssh2。**
`ssh` 已经帮你处理了 `~/.ssh/config`、密钥、ssh-agent、ProxyJump、ProxyCommand、跳板机模板。自建 ssh2 客户端要把这些重新实现一遍，且每一处偏差都会表现成"连不上"。因此探测/启动/转发全部走 `ssh <alias>`，隧道用 `ssh -N -L`，与本机终端里的 `ssh grid` 行为完全一致。

**2. 本地端口 = 远程端口，不用 `--public-url` 改号。**
DSH 的登录 cookie 绑定 `host:port`（实测：cookie 里写着 `authority: 127.0.0.1:<port>`，换一个端口访问即使带 cookie 也是 401）。所以隧道不能把远程端口映射成别的本地端口——否则浏览器身份永远对不上。实现方式：先在本地与远程各验一次端口空闲，然后**同一个端口号**两边都用（远程 `--port P`，本地 `-L 127.0.0.1:P:127.0.0.1:P`）。这样浏览器 authority、cookie authority、转发端口三者一致。

**3. 远程脚本走 stdin，不进命令行。**
脚本通过 `ssh <host> bash` / `wsl.exe ... -- bash` 的 **stdin** 送入，而不是 `bash -c '<脚本>'`：Windows 的命令行重解析会把引号和 `$(...)` 撕碎（实测 WSL 上表现为探测输出全空）。

**4. iframe 用"免 cookie 的本地反向代理"承载，而不是直接嵌远程。**
远程 index 响应既没有 `X-Frame-Options`，也没有 CSP / `frame-ancestors`，本身可以嵌套。真正的问题在认证：远程登录 cookie 是 `SameSite=Strict`，而**桌面端页面跑在 `app` 这个自定义 origin 上**（`window.location.hostname === 'app'`），所以任何 http iframe 都是跨站，`Strict` cookie 永远不会被发送——不管远程绑 `127.0.0.1` 还是 `localhost` 都一样（真实 Chromium 复现：`localhost` 页面 + `127.0.0.1` iframe → COOKIE BLOCKED；两边同为 `localhost` → 正常；而 `app` origin 没有任何 http 写法能对齐）。

解法是让浏览器根本不持有凭据：

1. 宿主进程做一次 `/?token=…` 握手，把 `Set-Cookie` 留在内存里；
2. iframe 指向本机一个 loopback 反向代理（`127.0.0.1:<proxyPort>`），代理把每个请求/WebSocket 升级转发给远程，并补上 `Cookie`、把 `Host` 改写成远程绑定的 authority；
3. 上游返回 401 时自动重新握手并重试一次；响应里的 `Set-Cookie` 一律不回给浏览器。

还有一道围栏要一起处理：远程 `/api` 会校验 `Origin` 是否等于自己的 authority，并拒绝 `Sec-Fetch-Site: cross-site`。iframe 发来的这两个标记天然不匹配（页面在 `app` origin），结果是页面能渲染、但 `/api` 与 mux 的 WebSocket 全被 403 —— 界面一直卡在「重新连接中」。代理因此把 `Origin` / `Referer` 改写成上游 authority、把 `Sec-Fetch-Site` 设为 `same-origin`，这正是第一方请求本来的样子。

于是浏览器看到一个普通 HTTP 服务，远程看到的是第一方请求，页面 URL 里不再有 token。健康检查就是"经代理匿名 GET `/` 必须 200"——之前"绿灯 + 嵌着 401"的假成功从此不可能出现；`tests/embed-auth.mjs` 另外断言带 `Origin` / 跨站标记的 WebSocket 升级必须拿到 101 且收到数据帧。

**5. 远程 dsh 用 `--port P` 而不是 `--port 0`。**
需求文档建议 `--port 0` 让系统分配；但那样拿到的端口无法与本机隧道端口对齐（见第 2 条）。改为：随机取一个端口，**先在本地和远程各做一次占用检查**再启动，失败就换一个。

**6. tmux 可选。**
有 tmux 就用 `tmux new-session -d`（可用 `kill-session` 精确停止）；没有就用 `setsid`/`nohup` + pid 文件。远程 dsh 的生命周期不依赖本地连接。

**7. 主机密钥用 `accept-new`。**
首次连接自动写入 `known_hosts`，指纹会在面板能力表里显示；密钥**变更**时拒绝连接并给出 `ssh-keygen -R` 提示。不做"信任所有主机"。

## 配置移植（本次新增）

远程刚装好的 dsh 没有任何服务商，嵌进去只会看到配置错误。所以装完会自动弹出「移植本地配置」：

- **模型服务商**：本机 profile 的 `llm-pi-ai` 条目（服务商、baseURL、模型列表）整块覆盖写进远端 patch；
- **默认模型**：`agent-default-model` 条目；
- **API 密钥**：本机 `.credentials.yaml` 的 `refs`（`THU_API_KEY` 等）合并进远端 `.credentials.yaml`；
- **DeepSeek 账号凭据**（默认关闭）：本机登录令牌，只在你信任这台服务器时勾选。

预览里**只出现键名与数量，不出现任何值**；日志不打印密钥；写入后可选「写入并重启」让远程 dsh 立刻生效。本机数据来源就是当前 profile 的配置，即你在本地设置页看到的东西。

**不会复制**：`client-connection/browser-session`（本机浏览器会话密钥，复制过去没有意义）、远程已有的其它 patch 行（逐字节保留）。

## 履行的需求映射

| 需求 | 状态 |
|---|---|
| FR-1.1/1.2/1.4 ssh config 解析（含 Include）、手动添加、持久化 0600 | ✅ |
| FR-1.3 WSL 发现 | ✅（`wsl.exe -l -v`，UTF-16 无 BOM 也已处理） |
| FR-2.1–2.3 探测、判定、10 分钟缓存 | ✅ |
| FR-3.1–3.6 计划先展示、免 sudo、测速选源、流式日志、失败诊断 | ✅ |
| FR-4.1–4.7 启动/隧道/健康检查/重连/停止 | ✅（端口策略见上） |
| FR-5.1/5.2 iframe + 工具栏 | ✅ |
| FR-5.3/5.4 记住选中目标、焦点不劫持 | ✅（滚动位置未做；iframe 内键盘由浏览器原生处理） |
| FR-6.1–6.3 状态机、可操作错误、30 分钟空闲断隧道 | ✅ |
| FR-7.1–7.4 WSL 同等对待、免 sudo 安装 | ✅ |
| FR-8.1–8.4 配置同步（默认关闭 → 现在作为装完后的推荐步骤） | ✅ |
| M3 ACP（远程会话出现在本地侧栏） | ❌ 未做，见下 |

## 已知限制

- **对话/项目管理的融合边界**：远程会话、工作区列表仍然由远程 DSH 自己的界面管理，只是被嵌在本地面板里；本地侧栏不会出现远程会话行。真正的"单一 UI、远程会话即本地会话"需要 ACP 子进程方案（需求 §9 M3），不在本版范围内。
- WSL 依赖 Windows ↔ WSL 的回环可达性（`networkingMode=mirrored`，或 NAT 模式下的 `localhostForwarding=true`）。两者都不满足时连接会报错并提示改 `.wslconfig`。
- 远端只支持 Linux x86_64 / arm64；需要 `bash`、`tar`、`curl` 或 `wget` 之一。
- 首次连接无法交互式确认主机指纹（`BatchMode=yes`）；指纹在连接后展示。
- 探测/安装要求目标可免密登录（密钥或 agent）；密码登录不支持。

## 排错

| 现象 | 处理 |
|---|---|
| 认证失败 | 先在终端确认 `ssh <别名>` 能免密登录 |
| 主机密钥校验失败 | `ssh-keygen -R <host>` 后重试 |
| 隧道没就绪 | 确认 `ssh -N -L` 没被 `AllowTcpForwarding no` 禁掉 |
| WSL 连接失败 | `.wslconfig` 里加 `[wsl2]` + `networkingMode=mirrored`，`wsl --shutdown` 后重试 |
| 远程界面空白 | 点「重载」；仍空白则查看远程 `~/.dsh-remote/<id>.log` |
| 远程界面能开但对话报错 | 用「移植本地配置」写入服务商与密钥，再重启远程 |
| 面板里 iframe 显示 "dsh web authentication required" | 已由本地反向代理解决（宿主持有 token，浏览器不需要 cookie）。若仍出现，说明宿主端代码没重载，重启一次 DSH |

## 测试

```bash
node tests/yaml-blocks.mjs        # 配置移植的文本手术（含 `[]` 占位符、备份、refs 合并）
node tests/routes.mjs             # 路由、loopback 围栏、CRUD、预览脱敏
node tests/embed-auth.mjs         # 内嵌认证：匿名 iframe 经代理拿不到 401、WebSocket 101
node tests/http-live.mjs          # 真机 HTTP：探测→配置→启动→匿名 iframe 200→停止
node tests/e2e-wsl.mjs            # 真机 WSL：探测 + 计划
node tests/e2e-wsl.mjs --install --start   # 真机 WSL：装 Node/dsh 并启动
node tests/e2e-wsl.mjs --start --sync      # 真机 WSL：移植本机配置并重启验证
node tests/cycle-wsl.mjs          # 诊断：start → stop → start 的第二轮启动
```

`tests/e2e-wsl.mjs` 与 `tests/cycle-wsl.mjs` 使用临时 registry 文件，不会污染 `~/.dsh/dsh-remote.json`；它们会在目标机上真正起停 dsh（结束时停止）。

`npm test` 只跑不需要远程机器的两项（CI 也只跑这两项）：

```
npm test          # = tests/yaml-blocks.mjs + tests/routes.mjs
```

已在 Debian 12 (WSL2) 上跑通：探测 → 免 sudo 装 Node v22.23.4 + dsh 0.2.1-rc.5 → 移植本机 providers/默认模型/API key → 启动 → 内嵌代理匿名 GET 返回 200 → WebSocket 101 → 重启 → 停止，且停止后不残留进程。

## 目录

```
dsh-remote/
├─ package.json            bundle 清单（dsh.bundle.patch + dsh.client）
├─ cordis.patch.yml        插入 id: remote 的 host 行
├─ icon.svg  locale/{zh,en}.json
├─ client.js               浏览器侧：侧栏入口 + 远程工作区页面（单文件，无需构建）
├─ lib/
│  ├─ index.js             插件入口：manager + routes
│  ├─ manager.js           状态机、探测缓存、启动/停止/重连、空闲回收
│  ├─ channel.js           ssh / wsl 通道、隧道、端口工具
│  ├─ probe.js             探测脚本与能力判定
│  ├─ bootstrap.js         安装计划、测速选源、流式执行
│  ├─ config-sync.js       本机配置 → 远程 profile
│  ├─ frame-proxy.js       内嵌认证代理（宿主持有 cookie，注入到上游）
│  ├─ yaml-blocks.js       配置文件的窄化文本手术
│  ├─ sshconfig.js         ~/.ssh/config 解析（含 Include）
│  ├─ wsl.js               wsl.exe 发现与解码
│  ├─ store.js             目标持久化（0600、原子替换）
│  ├─ routes.js            /api/dsh-remote/*
│  ├─ loopback.js          loopback 围栏
│  ├─ http.js  paths.js
├─ tests/
├─ .github/workflows/ci.yml  解析检查 + 两项不依赖远程的测试
└─ LICENSE
```

## 许可

MIT
