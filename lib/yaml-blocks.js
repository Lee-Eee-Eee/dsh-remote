/**
 * Narrow, text-level YAML surgery for the two DSH configuration files this
 * plugin ports. It is deliberately not a general YAML parser: DSH writes both
 * files itself in a regular block style (a top-level sequence of `- id: ...`
 * entries, or top-level mappings with two-space children), and porting a
 * *machine-written* file only needs those two shapes to be recognized
 * reliably.
 *
 * Every operation is backed up before it runs (see config-sync), and every
 * operation keeps unrelated text byte-for-byte, so a row this plugin does not
 * understand is never lost.
 * Account exports additionally require recognizable block mappings: copying
 * opaque YAML would let a quoted key, alias or merge bypass session filtering.
 * @module dsh-remote/yaml-blocks
 */

/** Split text into lines, keeping the trailing-newline shape. */
function toLines(text) {
  return String(text ?? '').split('\n')
}

/**
 * Drop a document-level empty-collection placeholder. A freshly bootstrapped
 * DSH profile writes `cordis.patch.yml` as its comment header followed by `[]`
 * (the empty patch list); appending a `- id:` entry after that literal makes
 * the file unparseable ("end of the stream or a document separator is
 * expected"), so the placeholder has to go before the first real entry lands.
 * @param {string} text - file text.
 * @returns {string} text without a column-0 `[]` / `{}` / `null` line.
 */
export function stripDocumentPlaceholder(text) {
  return toLines(text).filter(line => !/^(\[\]|\{\}|null)\s*$/.test(line)).join('\n')
}

/**
 * Split a top-level YAML sequence into entries. An entry starts at a line that
 * begins with `- ` at column 0 and runs to the next such line.
 * @param {string} text - file text.
 * @returns {Array<{start: number, end: number, text: string, id?: string}>} entries with line ranges.
 */
export function splitSequenceEntries(text) {
  const lines = toLines(text)
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^- /.test(lines[index])) starts.push(index)
  }
  const entries = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length
    const block = lines.slice(start, end).join('\n')
    const idMatch = /^- id:\s*(.+)$/m.exec(block)
    entries.push({
      start,
      end,
      text: block,
      id: idMatch === null ? undefined : idMatch[1].trim().replace(/^['"]|['"]$/g, ''),
    })
  }
  return entries
}

/**
 * Find the text of one sequence entry by its loader id.
 * @param {string} text - file text.
 * @param {string} id - loader entry id, e.g. `llm-pi-ai`.
 * @returns {string | undefined} the entry block, including its leading `- `.
 */
export function findSequenceEntry(text, id) {
  const entry = splitSequenceEntries(text).find(item => item.id === id)
  return entry?.text
}

/**
 * Insert or replace one sequence entry, leaving every other byte intact.
 * @param {string} text - current file text (may be empty).
 * @param {string} block - replacement block, starting with `- `.
 * @param {string} id - entry id the block declares.
 * @returns {string} new file text.
 */
export function upsertSequenceEntry(text, block, id) {
  const trimmedBlock = block.replace(/\s+$/, '')
  const source = text === undefined || text === null ? '' : stripDocumentPlaceholder(String(text))
  if (source.trim() === '') return `${trimmedBlock}\n`
  const lines = toLines(source)
  const entry = splitSequenceEntries(source).find(item => item.id === id)
  if (entry !== undefined) {
    const next = [
      ...lines.slice(0, entry.start),
      ...toLines(trimmedBlock),
      ...lines.slice(entry.end),
    ]
    return next.join('\n')
  }
  const endsWithNewline = source.endsWith('\n')
  const body = endsWithNewline ? source.slice(0, -1) : source
  return `${body}\n${trimmedBlock}${endsWithNewline ? '\n' : ''}`
}

/**
 * Read one top-level mapping block (`key:` plus its indented children) from a
 * settings file.
 * @param {string} text - file text.
 * @param {string} key - top-level key.
 * @returns {string | undefined} block text including the `key:` line.
 */
export function findTopLevelBlock(text, key) {
  const lines = toLines(text)
  const head = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`)
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (head.test(lines[index])) {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) && lines[index].trim() !== '') {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '')
}

/**
 * Select portable account records, excluding the local browser-session record
 * and its entire payload. Only DSH's block-mapping shape is accepted; unknown
 * keys or YAML indirection must not make client authentication portable.
 * @param {string | undefined} block - the local `records:` mapping block.
 * @returns {string | undefined} filtered block, or undefined when empty or unsafe to identify.
 */
export function filterAccountRecords(block) {
  if (typeof block !== 'string') return undefined
  const lines = block.replace(/\r\n?/g, '\n').split('\n')
  if (!/^records:[ \t]*(?:#.*)?$/.test(lines[0])) return undefined
  const entries = []
  let current
  let literalIndent
  for (const line of lines.slice(1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) {
      current?.lines.push(line)
      continue
    }
    const indent = /^ */.exec(line)[0].length
    // Literal strings may contain text that resembles YAML keys or aliases.
    if (literalIndent !== undefined && indent > literalIndent) {
      current.lines.push(line)
      continue
    }
    literalIndent = undefined
    if (indent === 2) {
      const match = /^ {2}("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9_./-]+):[ \t]*(?:#.*)?$/.exec(line)
      if (match === null) return undefined
      const rawKey = match[1]
      let key
      if (rawKey.startsWith('"')) {
        try {
          key = JSON.parse(rawKey)
        } catch {
          // YAML-only escapes cannot safely be compared without a full parser.
          return undefined
        }
      } else {
        key = rawKey.startsWith("'") ? rawKey.slice(1, -1).replace(/''/g, "'") : rawKey
      }
      current = { key, lines: [line] }
      entries.push(current)
    } else if (indent >= 4 && current !== undefined && !/^ *\t/.test(line)) {
      // Reject aliases, anchors and tags outside quoted strings. They can
      // refer to a session payload in another block or leave dangling YAML.
      const code = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '').replace(/#.*$/, '')
      if (/(?:^|[\s[\]{},:])[&*!]\S/.test(code)) return undefined
      current.lines.push(line)
      if (/:\s*[>|][1-9+-]{0,2}\s*$/.test(code)) literalIndent = indent
    } else {
      return undefined
    }
  }
  const portable = entries.filter(entry => entry.key !== 'client-connection/browser-session')
  if (portable.length === 0) return undefined
  return ['records:', ...portable.flatMap(entry => entry.lines)].join('\n').replace(/\s+$/, '')
}

/**
 * Parse the `refs:` mapping of `.credentials.yaml` into name → raw value pairs.
 * @param {string} text - credentials file text.
 * @returns {Map<string, string>} reference names to their scalar values.
 */
export function readCredentialRefs(text) {
  const refs = new Map()
  const block = findTopLevelBlock(text, 'refs')
  if (block === undefined) return refs
  for (const line of block.split('\n').slice(1)) {
    const match = /^\s{2,}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    refs.set(match[1], unquoteScalar(match[2]))
  }
  return refs
}

/** Strip surrounding quotes from a scalar. */
function unquoteScalar(raw) {
  const value = String(raw ?? '').trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value)
      } catch {
        return value.slice(1, -1)
      }
    }
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Render a scalar as a safe double-quoted YAML string. */
export function quoteScalar(value) {
  return JSON.stringify(String(value ?? ''))
}

/**
 * Merge references into a credentials file, preserving every other block
 * (records included).
 * @param {string} existingText - current remote file text (may be empty).
 * @param {Map<string, string>} refs - name → value.
 * @returns {string} new file text.
 */
export function mergeCredentialRefs(existingText, refs) {
  const source = existingText === undefined || existingText === null ? '' : String(existingText)
  if (refs.size === 0) return source
  if (source.trim() === '') {
    const lines = ['version: 1', 'refs:']
    for (const [name, value] of refs) lines.push(`  ${name}: ${quoteScalar(value)}`)
    return `${lines.join('\n')}\n`
  }
  const lines = toLines(source)
  const block = findTopLevelBlock(source, 'refs')
  if (block === undefined) {
    const body = source.endsWith('\n') ? source.slice(0, -1) : source
    const appended = ['refs:']
    for (const [name, value] of refs) appended.push(`  ${name}: ${quoteScalar(value)}`)
    return `${body}\n${appended.join('\n')}\n`
  }
  const start = lines.indexOf(block.split('\n')[0])
  const blockLines = block.split('\n')
  const children = blockLines.slice(1)
  for (const [name, value] of refs) {
    const line = `  ${name}: ${quoteScalar(value)}`
    const index = children.findIndex(child => new RegExp(`^\\s{2,}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(child))
    if (index >= 0) children[index] = line
    else children.push(line)
  }
  const next = [...lines.slice(0, start), ...children.length === 0 ? ['refs:'] : ['refs:', ...children], ...lines.slice(start + blockLines.length)]
  return next.join('\n')
}

/**
 * Replace (or append) one top-level mapping block in a settings file.
 * @param {string} existingText - current text.
 * @param {string} key - top-level key.
 * @param {string} block - block text starting with `key:`.
 * @returns {string} new file text.
 */
export function upsertTopLevelBlock(existingText, key, block) {
  const source = existingText === undefined || existingText === null ? '' : stripDocumentPlaceholder(String(existingText))
  const trimmed = block.replace(/\s+$/, '')
  if (source.trim() === '') return `${trimmed}\n`
  const current = findTopLevelBlock(source, key)
  const lines = toLines(source)
  if (current === undefined) {
    const body = source.endsWith('\n') ? source.slice(0, -1) : source
    return `${body}\n${trimmed}\n`
  }
  const start = lines.indexOf(current.split('\n')[0])
  const next = [...lines.slice(0, start), ...toLines(trimmed), ...lines.slice(start + current.split('\n').length)]
  return next.join('\n')
}

/**
 * Summarize providers from an `llm-pi-ai` entry block: names and model counts,
 * never key material.
 * @param {string | undefined} block - the `llm-pi-ai` entry.
 * @returns {{providers: Array<{name: string, models: number}>, modelCount: number}} summary.
 */
export function summarizeProviders(block) {
  if (block === undefined) return { providers: [], modelCount: 0 }
  const providers = []
  let current
  for (const line of block.split('\n')) {
    const provider = /^\s{6}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (provider !== null && /providers:\s*$/.test(line) === false) {
      if (current !== undefined) providers.push(current)
      current = { name: provider[1], models: 0 }
      continue
    }
    if (current !== undefined && /^\s{10}-\s*id:/.test(line)) current.models += 1
  }
  if (current !== undefined) providers.push(current)
  return { providers, modelCount: providers.reduce((sum, item) => sum + item.models, 0) }
}

/**
 * Read `provider` / `model` out of an `agent-default-model` entry.
 * @param {string | undefined} block - the entry block.
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}} summary.
 */
export function summarizeDefaultModel(block) {
  if (block === undefined) return {}
  const pick = (key) => {
    const match = new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm').exec(block)
    return match === null ? undefined : unquoteScalar(match[1])
  }
  return { provider: pick('provider'), model: pick('model'), reasoningEffort: pick('reasoningEffort') }
}
