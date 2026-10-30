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
import { buildRemoteCredentials, buildRemotePatch, readLocalConfig } from '../lib/config-sync.js'

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
console.log('yaml-blocks: all assertions passed')
