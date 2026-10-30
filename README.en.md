# dsh-remote · Remote Workspace

Turn any SSH host or WSL distribution into a DSH workspace. A sidebar entry lists
`~/.ssh/config` hosts and WSL distributions; one click probes the machine,
installs Node + dsh without sudo when needed, ports this machine's model
configuration, opens a loopback tunnel, and embeds the remote DSH UI inside the
local one.

See [README.md](README.md) for the full documentation (Chinese, primary).

## Quick start

```bash
git clone git@github.com:Lee-Eee-Eee/dsh-remote.git
cd dsh-remote
dsh plugin --profile desktop add "$PWD"     # no build step, the repo is the bundle
```

Then: Sidebar → **Remote** → pick a target → **Probe** → review the install plan
→ **Start install** → **Port local config** (offered automatically) → **Connect**.

## Design notes

- Drives the local OpenSSH client (`ssh`, `ssh -N -L`) instead of embedding an
  SSH stack: keys, agent, `ProxyJump`, `ProxyCommand` and config aliases behave
  exactly as they do in a terminal.
- Remote scripts travel on stdin (`ssh host bash`), never as a command-line
  argument — Windows re-parsing mangles quotes and `$(...)`.
- The tunnel reuses the *same* port number on both sides, so the remote's
  authority and the forwarded port agree.
- The iframe is served by a **local auth-injecting reverse proxy** rather than by
  the remote directly. A DSH auth cookie is `SameSite=Strict`, and the desktop
  page runs on a custom `app` origin, so every iframe is cross-site and the
  cookie would never be sent. The host process performs the `/ ?token=…`
  handshake itself, keeps the cookie in memory, and adds it to each forwarded
  request and WebSocket upgrade. The page URL therefore carries no token, and the
  health check is "an anonymous GET through the proxy returns the UI".
- Configuration porting copies only the `llm-pi-ai` provider rows, the
  `agent-default-model` row and the credential `refs`; previews list key names
  and counts only, never values. Remote files are backed up to
  `*.bak-<timestamp>` first, and the local browser-session record is never
  copied.

## Limitations

- Remote conversations and projects stay inside the remote DSH UI that the panel
  embeds; they are not projected into the local sidebar. That needs the ACP
  child-process design (`ssh host dsh --profile acp`) and a client-side session
  adapter — a separate milestone, not part of this version.
- Targets must be Linux (x86_64 / arm64) with `bash` and `tar`, reachable without
  a password (key or ssh-agent). WSL needs Windows ↔ WSL loopback reachability
  (`networkingMode=mirrored`, or `localhostForwarding=true` in NAT mode).

## Tests

```bash
npm test                 # configuration porting + route family (host-independent)
npm run test:embed       # real target: anonymous iframe gets the UI, WebSocket 101
npm run test:http        # real target: probe → config → start → stop over HTTP
```

## License

MIT — see [LICENSE](LICENSE).
