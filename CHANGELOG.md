# Changelog

## Unreleased

- Rewrite the Chinese and English READMEs around features, installation and first use. Move implementation details into a bilingual technical reference and development instructions into `CONTRIBUTING.md`.
- Clarify that the API-key configuration group copies secret values to the remote target; only the preview hides values.

## 0.1.2 — 2026-11-01

- Add a desktop screenshot, setup and authentication diagrams, and version-pinned GitHub installation instructions.
- Allow public bundle index discovery, include README images in the package and declare their marketplace order in `screenshots.json`.
- Make the WSL cycle test return a nonzero exit on failure and stop its second instance during cleanup.

## 0.1.1

- Rewrite Origin, Referer and Sec-Fetch-Site in the proxy so embedded API and WebSocket requests pass the remote fence.
