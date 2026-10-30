/**
 * Local → remote DSH configuration porting.
 *
 * A fresh `dsh` on a server starts with no model providers, which makes the
 * embedded UI useless until the user configures it there by hand. This module
 * copies the parts of the local configuration that describe *models* — the
 * `llm-pi-ai` provider rows, the `agent-default-model` row, and the credential
 * `refs` those providers name — into the remote profile, with two guarantees:
 *
 *   - the preview never carries a secret: it reports key *names*, provider
 *     names and model counts only, because the panel renders what it receives;
 *   - the write is reversible: every remote file is copied to
 *     `<name>.bak-<timestamp>` first, and unrelated rows in the remote patch
 *     are preserved byte-for-byte.
 *
 * Local source: this machine's profile patch (`~/.dsh/profiles/<profile>/
 * cordis.patch.yml`, where DSH itself stores plugin settings) plus
 * `~/.dsh/.credentials.yaml`. The local profile is the one the running host
 * belongs to (`DSH_PROFILE`), so what the user sees here is what gets ported.
 * @module dsh-remote/config-sync
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDirectory } from './paths.js'
import {
  findSequenceEntry,
  findTopLevelBlock,
  mergeCredentialRefs,
  readCredentialRefs,
  summarizeDefaultModel,
  summarizeProviders,
  upsertSequenceEntry,
  upsertTopLevelBlock,
} from './yaml-blocks.js'

/** Remote profile `dsh web` boots (the start command runs `dsh web`). */
export const REMOTE_PROFILE = 'web'

/** Remote patch path, as a shell fragment. */
export const REMOTE_PATCH = `$HOME/.dsh/profiles/${REMOTE_PROFILE}/cordis.patch.yml`

/** Remote credentials path, as a shell fragment. */
export const REMOTE_CREDENTIALS = '$HOME/.dsh/.credentials.yaml'

/** Local profile name the host runs as. */
export function localProfile(env = process.env) {
  const value = env.DSH_PROFILE
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'desktop'
}

/**
 * Read the local model configuration.
 * @param {{dshHome?: string, profile?: string, env?: NodeJS.ProcessEnv}} [options] - overrides.
 * @returns {object} preview plus the raw blocks kept host-side only.
 */
export function readLocalConfig(options = {}) {
  const dshHome = options.dshHome ?? dataDirectory(options.env)
  const profile = options.profile ?? localProfile(options.env)
  const patchFile = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  const credentialsFile = join(dshHome, '.credentials.yaml')
  const settingsFile = join(dshHome, 'settings.yaml')

  let patch = ''
  let patchSource = patchFile
  if (existsSync(patchFile)) {
    patch = safeRead(patchFile)
  } else if (existsSync(settingsFile)) {
    patch = safeRead(settingsFile)
    patchSource = settingsFile
  }
  const credentials = existsSync(credentialsFile) ? safeRead(credentialsFile) : ''

  const providersBlock = patchSource.endsWith('settings.yaml')
    ? findTopLevelBlock(patch, 'llm-pi-ai')
    : findSequenceEntry(patch, 'llm-pi-ai')
  const defaultModelBlock = patchSource.endsWith('settings.yaml')
    ? findTopLevelBlock(patch, 'agent-default-model')
    : findSequenceEntry(patch, 'agent-default-model')
  const refs = readCredentialRefs(credentials)
  const recordsBlock = findTopLevelBlock(credentials, 'records')

  const providerSummary = summarizeProviders(providersBlock)
  const modelSummary = summarizeDefaultModel(defaultModelBlock)

  const items = [
    {
      id: 'providers',
      title: '模型服务商',
      detail: providerSummary.providers.length === 0
        ? '本机没有 llm-pi-ai.providers 配置'
        : `${providerSummary.providers.map(item => item.name).join(', ')} · 共 ${providerSummary.modelCount} 个模型`,
      present: providersBlock !== undefined,
      secret: false,
      defaultOn: true,
    },
    {
      id: 'default-model',
      title: '默认模型',
      detail: modelSummary.provider === undefined
        ? '本机没有 agent-default-model 配置'
        : `${modelSummary.provider} / ${modelSummary.model ?? '?'}${modelSummary.reasoningEffort === undefined ? '' : ` · reasoning ${modelSummary.reasoningEffort}`}`,
      present: defaultModelBlock !== undefined,
      secret: false,
      defaultOn: true,
    },
    {
      id: 'api-keys',
      title: 'API 密钥（credentials refs）',
      detail: refs.size === 0
        ? '本机没有 API 密钥'
        : `${[...refs.keys()].join(', ')}（值不会显示，也不写入日志）`,
      present: refs.size > 0,
      secret: true,
      defaultOn: true,
    },
    {
      id: 'account',
      title: 'DeepSeek 账号凭据（可选）',
      detail: recordsBlock === undefined
        ? '本机没有账号记录'
        : '包含本机登录令牌；只在信任这台服务器时勾选',
      present: recordsBlock !== undefined,
      secret: true,
      defaultOn: false,
    },
  ]

  return {
    profile,
    patchSource,
    items: items.map(item => ({ ...item, defaultOn: item.present === true && item.defaultOn === true })),
    // Host-side payload for apply(); never serialized into a response.
    blocks: { providers: providersBlock, defaultModel: defaultModelBlock, records: recordsBlock },
    refs,
    hasAny: items.some(item => item.present),
  }
}

/** Read a file, treating an unreadable path as empty. */
function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Compute the remote patch text after porting the selected items.
 * @param {string} remotePatch - current remote patch text ('' when absent).
 * @param {object} local - result of {@link readLocalConfig}.
 * @param {Set<string>} selected - selected item ids.
 * @returns {string | undefined} new patch text, or undefined when nothing applies.
 */
export function buildRemotePatch(remotePatch, local, selected) {
  let text = remotePatch ?? ''
  let touched = false
  if (selected.has('providers') && local.blocks.providers !== undefined) {
    text = upsertSequenceEntry(text, local.blocks.providers, 'llm-pi-ai')
    touched = true
  }
  if (selected.has('default-model') && local.blocks.defaultModel !== undefined) {
    text = upsertSequenceEntry(text, local.blocks.defaultModel, 'agent-default-model')
    touched = true
  }
  return touched ? text : undefined
}

/**
 * Compute the remote credentials text after porting the selected items.
 * @param {string} remoteCredentials - current remote text ('' when absent).
 * @param {object} local - result of {@link readLocalConfig}.
 * @param {Set<string>} selected - selected item ids.
 * @returns {string | undefined} new credentials text.
 */
export function buildRemoteCredentials(remoteCredentials, local, selected) {
  let text = remoteCredentials ?? ''
  let touched = false
  if (selected.has('api-keys') && local.refs.size > 0) {
    text = mergeCredentialRefs(text, local.refs)
    touched = true
  }
  if (selected.has('account') && local.blocks.records !== undefined) {
    text = upsertTopLevelBlock(text, 'records', local.blocks.records)
    touched = true
  }
  return touched ? text : undefined
}

/**
 * Write one remote file through a backup + base64 script.
 * @param {{channel: object, path: string, content: string}} options - target and payload.
 * @returns {Promise<{ok: boolean, message?: string, backup?: string}>} outcome.
 */
async function writeRemoteFile({ channel, path, content }) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const encoded = Buffer.from(content, 'utf8').toString('base64')
  const script = [
    'set -e',
    'umask 077',
    `dir=$(dirname ${path})`,
    'mkdir -p "$dir"',
    'backup=""',
    `if [ -f ${path} ]; then backup="${path}.bak-${stamp}"; cp -p ${path} "$backup"; fi`,
    `printf '%s' '${encoded}' | base64 -d > ${path}`,
    `chmod 600 ${path}`,
    'printf \'WROTE=%s\\n\' "$backup"',
  ].join('\n')
  const result = await channel.exec(script, { timeoutMs: 30000 })
  if (result.code !== 0) {
    return { ok: false, message: (result.error ?? result.stderr ?? 'write failed').trim() }
  }
  const backup = /WROTE=(.*)/.exec(result.stdout ?? '')?.[1]?.trim()
  return { ok: true, backup: backup === '' ? undefined : backup }
}

/**
 * Port the selected local configuration items into the remote profile.
 * @param {{channel: object, local: object, selected: Set<string>}} options - run context.
 * @returns {Promise<{ok: boolean, wrote: string[], backups: string[], message?: string}>} outcome.
 */
export async function applyConfigSync({ channel, local, selected }) {
  const readPatch = await channel.exec(`cat ${REMOTE_PATCH} 2>/dev/null || true`, { timeoutMs: 15000 })
  const readCreds = await channel.exec(`cat ${REMOTE_CREDENTIALS} 2>/dev/null || true`, { timeoutMs: 15000 })

  const nextPatch = buildRemotePatch(readPatch.stdout ?? '', local, selected)
  const nextCreds = buildRemoteCredentials(readCreds.stdout ?? '', local, selected)
  const wrote = []
  const backups = []

  if (nextPatch !== undefined) {
    const result = await writeRemoteFile({ channel, path: REMOTE_PATCH, content: nextPatch })
    if (!result.ok) return { ok: false, wrote, backups, message: `写入远程 patch 失败：${result.message}` }
    wrote.push(REMOTE_PATCH)
    if (result.backup !== undefined) backups.push(result.backup)
  }
  if (nextCreds !== undefined) {
    const result = await writeRemoteFile({ channel, path: REMOTE_CREDENTIALS, content: nextCreds })
    if (!result.ok) return { ok: false, wrote, backups, message: `写入远程凭据失败：${result.message}` }
    wrote.push(REMOTE_CREDENTIALS)
    if (result.backup !== undefined) backups.push(result.backup)
  }
  if (wrote.length === 0) return { ok: false, wrote, backups, message: '没有可写入的配置项。' }
  return { ok: true, wrote, backups }
}
