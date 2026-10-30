/**
 * Local target registry: the saved SSH / WSL targets, persisted as
 * `~/.dsh/dsh-remote.json` (0600, atomic replace). Runtime state (token,
 * tunnel, ports) never touches this file — it lives in memory only.
 * @module dsh-remote/store
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Compact, URL-safe identifier (12 hex chars). */
export function newId() {
  return randomBytes(6).toString('hex')
}

/** Coerce a value to a trimmed string or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Coerce a value to an integer port or undefined. */
function port(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined
}

/**
 * Normalize one incoming target payload into the persisted shape.
 * @param {Record<string, unknown>} payload - untrusted body.
 * @param {{id?: string, createdAt?: number}} [seeds] - server-owned fields.
 * @returns {Record<string, unknown>} normalized target.
 * @throws {Error} when the required connector fields are missing.
 */
export function normalizeTarget(payload, seeds = {}) {
  const kind = payload.kind === 'wsl' ? 'wsl' : payload.kind === 'ssh' ? 'ssh' : undefined
  if (kind === undefined) throw new Error('kind must be "ssh" or "wsl"')
  const label = text(payload.label)
  const now = Date.now()
  if (kind === 'wsl') {
    const distro = text(payload.wsl?.distro) ?? text(payload.distro)
    if (distro === undefined) throw new Error('wsl target requires a distribution name')
    return {
      id: seeds.id ?? newId(),
      kind,
      label: label ?? distro,
      wsl: { distro },
      autoStart: payload.autoStart === true,
      createdAt: seeds.createdAt ?? now,
      updatedAt: now,
    }
  }
  const sshInput = payload.ssh ?? payload
  const alias = text(sshInput.alias)
  const hostName = text(sshInput.hostName) ?? text(sshInput.host)
  if (alias === undefined && hostName === undefined) {
    throw new Error('ssh target requires an alias or a host address')
  }
  return {
    id: seeds.id ?? newId(),
    kind,
    label: label ?? alias ?? hostName,
    ssh: {
      alias,
      hostName,
      user: text(sshInput.user),
      port: port(sshInput.port),
      identityFile: text(sshInput.identityFile),
      proxyJump: text(sshInput.proxyJump),
    },
    autoStart: payload.autoStart === true,
    createdAt: seeds.createdAt ?? now,
    updatedAt: now,
  }
}

/** The persisted document. */
export class TargetStore {
  /** @param {{file: string}} options - registry path. */
  constructor({ file }) {
    this.file = file
    this.targets = []
    this.load()
  }

  /** Read the registry, tolerating a missing or damaged file. */
  load() {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.targets) ? parsed.targets : []
      this.targets = list.filter(item => item && typeof item === 'object' && typeof item.id === 'string')
    } catch {
      this.targets = []
    }
    return this.targets
  }

  /** Persist the registry atomically with 0600 permissions. */
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ version: 1, targets: this.targets }, null, 2)
    const temp = `${this.file}.tmp-${process.pid}`
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(temp, 0o600)
    } catch {
      /* best effort on platforms without POSIX modes */
    }
    renameSync(temp, this.file)
  }

  /** @returns {Array<Record<string, unknown>>} every saved target, in insertion order. */
  list() {
    return this.targets.slice()
  }

  /** @param {string} id - target id. */
  get(id) {
    return this.targets.find(target => target.id === id)
  }

  /**
   * Create a target from an untrusted payload.
   * @param {Record<string, unknown>} payload - request body.
   * @returns {Record<string, unknown>} the stored target.
   */
  create(payload) {
    const target = normalizeTarget(payload)
    if (this.targets.some(item => sameIdentity(item, target))) {
      throw new Error('a target for this host already exists')
    }
    this.targets.push(target)
    this.save()
    return target
  }

  /**
   * Patch the label / autoStart switch of one target.
   * @param {string} id - target id.
   * @param {Record<string, unknown>} patch - fields to change.
   * @returns {Record<string, unknown> | undefined} the updated target.
   */
  update(id, patch) {
    const target = this.get(id)
    if (target === undefined) return undefined
    const label = text(patch.label)
    if (label !== undefined) target.label = label
    if (typeof patch.autoStart === 'boolean') target.autoStart = patch.autoStart
    target.updatedAt = Date.now()
    this.save()
    return target
  }

  /**
   * Remove one target. The remote installation is left untouched.
   * @param {string} id - target id.
   * @returns {boolean} whether a target was removed.
   */
  remove(id) {
    const before = this.targets.length
    this.targets = this.targets.filter(target => target.id !== id)
    if (this.targets.length === before) return false
    this.save()
    return true
  }
}

/** Whether two targets address the same remote connector. */
function sameIdentity(a, b) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'wsl') return a.wsl?.distro === b.wsl?.distro
  if (a.ssh?.alias !== undefined || b.ssh?.alias !== undefined) return a.ssh?.alias === b.ssh?.alias
  return a.ssh?.user === b.ssh?.user
    && a.ssh?.hostName === b.ssh?.hostName
    && (a.ssh?.port ?? 22) === (b.ssh?.port ?? 22)
}
