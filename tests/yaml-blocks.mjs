/**
 * Unit checks for the text-level YAML surgery used by the config port.
 * Run: node tests/yaml-blocks.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSequenceEntry,
  mergeCredentialRefs,
  readCredentialRefs,
  summarizeDefaultModel,
  summarizeProviders,
  upsertSequenceEntry,
} from '../lib/yaml-blocks.js'
import { applyConfigSync, buildRemoteCredentials, buildRemotePatch, readLocalConfig } from '../lib/config-sync.js'

const REMOTE_PATCH = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      old:
        displayName: Old
        apiKeyEnv: OLD_KEY
`

// --- replace an existing entry, keep the neighbours -------------------------
const replaced = upsertSequenceEntry(REMOTE_PATCH, `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      thu:
        displayName: thu
        apiKeyEnv: THU_API_KEY
        models:
          - id: GLM-5.3
          - id: Kimi-K3
`, 'llm-pi-ai')
assert.match(replaced, /^- id: ui-theme/m, 'unrelated entry survives')
assert.match(replaced, /GLM-5\.3/)
assert.match(replaced, /Kimi-K3/)
assert.doesNotMatch(replaced, /OLD_KEY/, 'old provider replaced, not merged')
assert.equal(summarizeProviders(findSequenceEntry(replaced, 'llm-pi-ai')).modelCount, 2)

// --- append a missing entry ------------------------------------------------
const appended = upsertSequenceEntry(REMOTE_PATCH, `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
`, 'agent-default-model')
assert.match(appended, /^- id: ui-theme/m)
assert.match(appended, /^- id: agent-default-model/m)
assert.deepEqual(summarizeDefaultModel(findSequenceEntry(appended, 'agent-default-model')), {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'high',
})

// --- credentials: merge refs into an existing file -------------------------
const remoteCreds = `version: 1
records:
  dsh-zotero/local-write-key:
    kind: local-write-key
    payload:
      key: keep-me
refs:
  OLD_KEY: "1"
`
const refs = readCredentialRefs(`version: 1
refs:
  THU_API_KEY: "abc"
  ANYROUTER_API_KEY: def
`)
assert.equal(refs.get('THU_API_KEY'), 'abc')
assert.equal(refs.get('ANYROUTER_API_KEY'), 'def')
const merged = mergeCredentialRefs(remoteCreds, refs)
assert.match(merged, /keep-me/, 'unrelated records survive')
assert.match(merged, /THU_API_KEY: "abc"/)
assert.match(merged, /ANYROUTER_API_KEY: "def"/)
assert.match(merged, /OLD_KEY: "1"/, 'existing ref survives')

// --- a freshly bootstrapped profile writes `[]` as the empty patch list ------
const BOOTSTRAPPED = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`
const seeded = upsertSequenceEntry(BOOTSTRAPPED, `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      thu:
        displayName: thu
        apiKeyEnv: THU_API_KEY
`, 'llm-pi-ai')
assert.doesNotMatch(seeded, /^\[\]$/m, 'the empty-array placeholder is removed')
assert.match(seeded, /# Your patch layer/)
assert.match(seeded, /^- id: llm-pi-ai/m)
// Appending a second entry keeps the first one.
const seededTwice = upsertSequenceEntry(seeded, `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
`, 'agent-default-model')
assert.match(seededTwice, /^- id: llm-pi-ai/m)
assert.match(seededTwice, /^- id: agent-default-model/m)

// --- end-to-end payload build from a fixture configuration -----------------
// A temporary DSH home keeps this test hermetic: CI machines have no ~/.dsh,
// and a developer's real configuration must not influence the assertions.
const fixture = mkdtempSync(join(tmpdir(), 'dsh-remote-fixture-'))
mkdirSync(join(fixture, 'profiles', 'desktop'), { recursive: true })
writeFileSync(join(fixture, 'profiles', 'desktop', 'cordis.patch.yml'), `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      fixture:
        displayName: Fixture
        apiKeyEnv: FIXTURE_KEY
        baseURL: https://example.invalid
        models:
          - id: model-a
          - id: model-b
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: fixture
    model: model-a
`)
writeFileSync(join(fixture, '.credentials.yaml'), `version: 1
records:
  client-connection/browser-session:
    kind: browser-session
    payload:
      secret: must-not-be-ported
refs:
  FIXTURE_KEY: "fixture-value"
`)
const local = readLocalConfig({ dshHome: fixture, profile: 'desktop' })
assert.equal(local.hasAny, true)
assert.match(local.items.find(item => item.id === 'default-model').detail, /fixture \/ model-a/)
const patch = buildRemotePatch(REMOTE_PATCH, local, new Set(['providers', 'default-model']))
assert.equal(typeof patch, 'string')
assert.match(patch, /^- id: llm-pi-ai/m)
assert.match(patch, /^- id: agent-default-model/m)
assert.match(patch, /FIXTURE_KEY/, 'the provider row keeps its apiKeyEnv reference')
assert.doesNotMatch(patch, /DEEPSEEK_API_KEY: /, 'keys stay in the credentials file, not the patch')
const creds = buildRemoteCredentials(remoteCreds, local, new Set(['api-keys']))
assert.match(creds, /FIXTURE_KEY: "fixture-value"/)
assert.match(creds, /OLD_KEY: "1"/, 'pre-existing remote refs survive the merge')
assert.doesNotMatch(creds, /must-not-be-ported/, 'the browser-session record is never ported')
assert.doesNotMatch(creds, /^ {2}secret:/m, 'no browser-session record is ported')

rmSync(fixture, { recursive: true, force: true })

// --- explicitly selecting account credentials must not port local sessions --
const accountFixture = mkdtempSync(join(tmpdir(), 'dsh-remote-account-fixture-'))
const accountCredentialsFile = join(accountFixture, '.credentials.yaml')
const remoteWithSession = `version: 1
records:
  client-connection/browser-session:
    kind: browser-session
    payload:
      secret: remote-session-stays-local-to-remote
refs:
  REMOTE_KEY: "remote-key-value"
metadata:
  owner: remote-metadata-kept
`
const browserSecret = 'synthetic-local-browser-secret-never-copy'
const localRecords = (browserKey) => `version: 1
records:
  deepseek/account-before:
    kind: account
    payload:
      token: synthetic-account-before
      label: "*literal-star-inside-quotes"
      note: |
        client-connection/browser-session: text-inside-an-account
        *literal-star-inside-block
  ${browserKey}:
    kind: browser-session
    payload:
      secret: |
        ${browserSecret}
        synthetic-browser-continuation-never-copy
      nested:
        value: synthetic-browser-nested-never-copy
  deepseek/account-after:
    kind: account
    payload:
      token: synthetic-account-after
refs:
  LOCAL_KEY: "local-key-value"
`
const browserKeys = [
  'client-connection/browser-session',
  "'client-connection/browser-session'",
  '"client-connection/browser-session"',
  String.raw`"client-connection\/browser-session"`,
  String.raw`"\u0063lient-connection/browser-session"`,
]

try {
  for (const browserKey of browserKeys) {
    for (const newline of ['\n', '\r\n']) {
      writeFileSync(accountCredentialsFile, localRecords(browserKey).replaceAll('\n', newline))
      const accountLocal = readLocalConfig({ dshHome: accountFixture, profile: 'desktop' })
      const accountItem = accountLocal.items.find(item => item.id === 'account')
      assert.equal(accountItem.present, true, 'ordinary account credentials remain available')
      assert.equal(accountItem.defaultOn, false, 'account credentials stay opt-in')
      const accountResult = buildRemoteCredentials(remoteWithSession, accountLocal, new Set(['account', 'api-keys']))
      assert.equal(typeof accountResult, 'string')
      assert.doesNotMatch(accountResult, new RegExp(browserSecret), 'account porting must omit the local browser-session secret')
      assert.doesNotMatch(accountResult, /synthetic-browser-(continuation|nested)-never-copy/, 'the entire browser-session payload is excluded')
      assert.match(accountResult, /synthetic-account-before/, 'the account preceding the browser session survives')
      assert.match(accountResult, /synthetic-account-after/, 'the account following the browser session survives')
      assert.match(accountResult, /text-inside-an-account/, 'browser-session text inside another account is not a record key')
      assert.match(accountResult, /\*literal-star-inside-quotes/, 'quoted literal stars are ordinary account data')
      assert.match(accountResult, /\*literal-star-inside-block/, 'block scalar content is not treated as an alias')
      assert.equal(readCredentialRefs(accountResult).get('LOCAL_KEY'), 'local-key-value', 'API-key porting still works alongside accounts')
      assert.equal(readCredentialRefs(accountResult).get('REMOTE_KEY'), 'remote-key-value', 'existing remote refs survive')
      assert.match(accountResult, /remote-metadata-kept/, 'unrelated remote top-level data survives')
      assert.doesNotMatch(JSON.stringify(accountLocal.items), /synthetic-account-before|synthetic-account-after|synthetic-local-browser-secret/, 'the preview remains free of credential values')
    }
  }

  const duplicateBrowserRecords = localRecords('client-connection/browser-session').replace('  deepseek/account-after:', `  "client-connection\\/browser-session":
    kind: browser-session
    payload:
      secret: synthetic-duplicate-browser-never-copy
  deepseek/account-after:`)
  writeFileSync(accountCredentialsFile, duplicateBrowserRecords)
  const duplicateLocal = readLocalConfig({ dshHome: accountFixture, profile: 'desktop' })
  const duplicateResult = buildRemoteCredentials(remoteWithSession, duplicateLocal, new Set(['account']))
  assert.doesNotMatch(duplicateResult, /synthetic-(?:local-browser-secret|duplicate-browser)-never-copy/, 'all occurrences of the local browser-session key are excluded')
  assert.match(duplicateResult, /synthetic-account-before/)
  assert.match(duplicateResult, /synthetic-account-after/)

  // Check the actual write payload as well as the pure document builder.
  writeFileSync(accountCredentialsFile, localRecords('client-connection/browser-session'))
  const writableLocal = readLocalConfig({ dshHome: accountFixture, profile: 'desktop' })

  // A caller holding an unfiltered block must not bypass the write boundary.
  for (const browserKey of browserKeys) {
    const rawRecords = localRecords(browserKey).replace(/^version: 1\n/, '').split('\nrefs:')[0]
    const rawLocal = { ...writableLocal, blocks: { ...writableLocal.blocks, records: rawRecords } }
    const rawResult = buildRemoteCredentials(remoteWithSession, rawLocal, new Set(['account']))
    assert.equal(typeof rawResult, 'string', 'ordinary accounts remain portable through the direct builder')
    assert.doesNotMatch(rawResult, new RegExp(browserSecret), 'an unfiltered host-side block cannot bypass session exclusion')
    assert.match(rawResult, /synthetic-account-before/)
    assert.match(rawResult, /synthetic-account-after/)
  }

  const writes = []
  const channel = {
    async exec(script) {
      if (script.startsWith('cat ')) {
        return { code: 0, stdout: script.includes('.credentials.yaml') ? remoteWithSession : '', stderr: '' }
      }
      const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)
      assert.ok(encoded, 'configuration writes carry a decodable payload')
      writes.push(Buffer.from(encoded[1], 'base64').toString('utf8'))
      return { code: 0, stdout: 'WROTE=/synthetic/credentials.bak-test\n', stderr: '' }
    },
  }
  const applied = await applyConfigSync({ channel, local: writableLocal, selected: new Set(['account', 'api-keys']) })
  assert.equal(applied.ok, true)
  assert.equal(writes.length, 1, 'only the credentials file needs writing')
  assert.doesNotMatch(writes[0], new RegExp(browserSecret), 'the remote write never contains the local session secret')
  assert.match(writes[0], /synthetic-account-before/)
  assert.match(writes[0], /synthetic-account-after/)

  // With no transferable accounts, selecting account must not erase the
  // remote's own session or other records. Refs remain independently portable.
  for (const browserKey of browserKeys) {
    const onlyBrowserBlock = `records:
  ${browserKey}:
    kind: browser-session
    payload:
      secret: ${browserSecret}
`
    writeFileSync(accountCredentialsFile, `version: 1
${onlyBrowserBlock}refs:
  LOCAL_KEY: "local-key-value"
`)
    const sessionOnly = readLocalConfig({ dshHome: accountFixture, profile: 'desktop' })
    const accountItem = sessionOnly.items.find(item => item.id === 'account')
    assert.equal(accountItem.present, false, 'a browser session is not a transferable account')
    assert.equal(accountItem.defaultOn, false)
    assert.equal(buildRemoteCredentials(remoteWithSession, sessionOnly, new Set(['account'])), undefined, 'account-only selection leaves remote records untouched when filtering removes every local account')
    const rawSessionOnly = { ...sessionOnly, blocks: { ...sessionOnly.blocks, records: onlyBrowserBlock } }
    assert.equal(buildRemoteCredentials(remoteWithSession, rawSessionOnly, new Set(['account'])), undefined, 'a raw browser-only block cannot trigger a remote records overwrite')
    const refsOnlyResult = buildRemoteCredentials(remoteWithSession, sessionOnly, new Set(['account', 'api-keys']))
    assert.match(refsOnlyResult, /remote-session-stays-local-to-remote/, 'the remote session survives an API-key merge')
    assert.match(refsOnlyResult, /remote-metadata-kept/)
    assert.equal(readCredentialRefs(refsOnlyResult).get('LOCAL_KEY'), 'local-key-value')
    assert.doesNotMatch(refsOnlyResult, new RegExp(browserSecret))
  }

  // The narrow editor must skip an account block it cannot identify safely,
  // including YAML-only key escapes and non-block mapping/alias structures.
  const unsupportedAccountBlocks = [
    'records:',
    'records: {}',
    localRecords(String.raw`"\x63lient-connection/browser-session"`).replace(/^version: 1\n/, '').split('\nrefs:')[0],
    'records: {"deepseek/account": {"token": "synthetic-flow-account"}, "client-connection/browser-session": {"secret": "synthetic-flow-browser"}}',
    `records:
  deepseek/account: {token: synthetic-flow-account}
  client-connection/browser-session:
    payload:
      secret: ${browserSecret}
`,
    `records:
  <<: *shared-records
  deepseek/account:
    payload:
      token: synthetic-merge-account
`,
    `records:
  deepseek/account: *shared-account
`,
  ]
  for (const records of unsupportedAccountBlocks) {
    writeFileSync(accountCredentialsFile, `version: 1\n${records}\nrefs:\n  LOCAL_KEY: "local-key-value"\n`)
    const unsupportedLocal = readLocalConfig({ dshHome: accountFixture, profile: 'desktop' })
    assert.equal(unsupportedLocal.items.find(item => item.id === 'account').present, false, 'unsupported account structures are unavailable for porting')
    const rawUnsupported = { ...unsupportedLocal, blocks: { ...unsupportedLocal.blocks, records } }
    assert.equal(buildRemoteCredentials(remoteWithSession, rawUnsupported, new Set(['account'])), undefined, 'unsupported account blocks fail closed at the write boundary')
    const refsResult = buildRemoteCredentials(remoteWithSession, rawUnsupported, new Set(['account', 'api-keys']))
    assert.match(refsResult, /remote-session-stays-local-to-remote/, 'skipping unsupported accounts keeps remote records')
    assert.equal(readCredentialRefs(refsResult).get('LOCAL_KEY'), 'local-key-value', 'unsupported account syntax does not block independent refs')
  }
} finally {
  rmSync(accountFixture, { recursive: true, force: true })
}

console.log('yaml-blocks: all assertions passed')
