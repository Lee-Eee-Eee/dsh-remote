# Contributing

[中文说明](README.md#文档与反馈) · [User guide](README.en.md) · [Technical reference](docs/architecture.en.md)

The repository is an installable DSH bundle. Host modules use ESM; the browser entry is a single JavaScript module. There is no build step or runtime dependency installation.

## Run from a checkout

Use Node `^22.19.0 || >=24` and a DSH host compatible with the package manifest.

```powershell
git clone https://github.com/Lee-Eee-Eee/dsh-remote.git
Set-Location dsh-remote
dsh plugin --profile desktop add "$($PWD.Path)"
```

Use the profile your host actually runs. Restart DSH after changing host modules; refresh the page after changing `client.js`.

## Validate changes

Run the host-independent tests:

```sh
npm test
```

This runs `tests/yaml-blocks.mjs` and `tests/routes.mjs`, covering configuration editing, backups, credential preview redaction, loopback fences and target CRUD. CI also parses every JavaScript module.

Before submitting changes, run the live suites against a prepared Debian WSL distribution:

```sh
node tests/embed-auth.mjs
node tests/http-live.mjs
node tests/e2e-wsl.mjs
node tests/cycle-wsl.mjs
```

Set `DISTRO` to test another WSL distribution. These suites use temporary target registries. The HTTP suite copies the selected local model configuration to the remote web profile, with backups before writing. The default e2e command only probes and prepares an installation plan; `--install --start` also installs and launches DSH.

The embed suite verifies an anonymous UI response, cross-site WebSocket upgrades and API POST forwarding. The cycle suite exercises two start/stop rounds and returns a nonzero exit on failure. After live tests, check the distribution for remaining `dsh web --no-open` processes and stop any test instances.

## Code organization

| Area | Files |
|---|---|
| Bundle entry and API routes | `lib/index.js`, `lib/routes.js`, `cordis.patch.yml` |
| Target lifecycle and connections | `lib/manager.js`, `lib/channel.js` |
| Discovery and environment setup | `lib/sshconfig.js`, `lib/wsl.js`, `lib/probe.js`, `lib/bootstrap.js` |
| Configuration porting | `lib/config-sync.js`, `lib/yaml-blocks.js` |
| Embedded authentication | `lib/frame-proxy.js` |
| Storage and HTTP helpers | `lib/store.js`, `lib/paths.js`, `lib/http.js`, `lib/loopback.js` |
| Browser UI and translations | `client.js` |

Keep the bundle directly installable: preserve `dsh.bundle` and `dsh.client`, use ordinary ESM, and keep runtime dependencies empty. Exported functions need JSDoc; module comments should explain design decisions. Tests use `node:assert` without a test framework.

Connection and authentication invariants are documented in the [technical reference](docs/architecture.en.md). Keep remote scripts on stdin, reuse the same SSH port on both ends, and validate the iframe through its authentication proxy. Review configuration changes for backups, secret redaction and preservation of unrelated blocks.

## Documentation and artwork

Keep the Chinese and English READMEs aligned when changing installation or usage. Put implementation explanations in the technical reference and release changes in [CHANGELOG.md](CHANGELOG.md).

The original desktop screenshot is `docs/assets/remote-workspace.png`. The two implementation diagrams are generated from `docs/figures/render.py` using Matplotlib and the ohmyplt Arial / Times New Roman conventions:

```sh
python docs/figures/render.py
```

Python, Matplotlib and the two fonts are needed only to regenerate diagrams. Keep the PNG, editable SVG and provenance manifest together. `screenshots.json` controls their order in supporting plugin catalogs.

When adding documentation links, check that referenced files and images are also included in `package.json`'s `files` list. Use `npm pack --dry-run` to inspect the package contents.

## Submit a change

Use a focused commit with an English conventional-commit message, such as `fix: recover a dropped tunnel`. Include the behavior change and relevant validation in the pull request. Report bugs with the DSH version, SSH or WSL target type, reproduction steps and sanitized error output.

Keep private design notes, `tmp/`, credentials and authentication links out of commits and issue reports.
