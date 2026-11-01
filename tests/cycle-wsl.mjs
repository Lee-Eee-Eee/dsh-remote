/**
 * Exercise stop → start on real WSL without hiding failures or leaving the
 * second server behind. Only this test's target and registry are cleaned up.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TargetManager, httpStatus, redactToken } from '../lib/manager.js'

const distro = process.env.DISTRO ?? 'Debian'
const homeDir = mkdtempSync(join(tmpdir(), 'dsh-remote-cycle-'))
const manager = new TargetManager({ file: join(homeDir, 'registry.json') })
const created = manager.create({ kind: 'wsl', label: `WSL ${distro}`, wsl: { distro } })

try {
  for (const round of [1, 2]) {
    const started = await manager.start(created.id)
    assert.equal(started.state, 'running')
    const url = new URL(started.url)
    assert.equal(url.search, '', 'the iframe URL must not contain a token')
    assert.equal(await httpStatus(Number(url.port), '/'), 200)
    console.log(`round ${round}: running; anonymous iframe -> 200`)
    const stopped = await manager.stop(created.id)
    assert.equal(stopped.state, 'idle')
    assert.equal(await httpStatus(Number(url.port), '/'), 0, 'stop releases the proxy')
    console.log(`round ${round}: stopped; proxy released`)
  }
  console.log('\ncycle-wsl: all assertions passed')
} catch (error) {
  console.error('cycle-wsl FAILED:', redactToken(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  await manager.stop(created.id).catch(() => { process.exitCode = 1 })
  manager.dispose()
  rmSync(homeDir, { recursive: true, force: true })
}
