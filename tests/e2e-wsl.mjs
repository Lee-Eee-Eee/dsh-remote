/**
 * End-to-end host-side check against a real WSL distribution.
 *
 * Drives TargetManager exactly as the HTTP routes do — create a target, probe,
 * build a plan, optionally run the install, then start the remote dsh and
 * verify the URL the panel would embed answers 303.
 *
 * Usage:
 *   node tests/e2e-wsl.mjs                 # probe + plan only
 *   node tests/e2e-wsl.mjs --install       # also run the bootstrap
 *   node tests/e2e-wsl.mjs --install --start
 *   node tests/e2e-wsl.mjs --start         # assume dsh is already installed
 *   DISTRO=Ubuntu node tests/e2e-wsl.mjs   # another distribution
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TargetManager } from '../lib/manager.js'

const distro = process.env.DISTRO ?? 'Debian'
const args = new Set(process.argv.slice(2))
const registryFile = join(tmpdir(), `dsh-remote-e2e-${distro}.json`)
if (existsSync(registryFile)) rmSync(registryFile)

const manager = new TargetManager({ file: registryFile })
const log = (...parts) => console.log(...parts)

try {
  const created = manager.create({ kind: 'wsl', label: `WSL ${distro}`, wsl: { distro } })
  log('created target:', created.id)

  log('\n=== probe ===')
  const probed = await manager.probe(created.id, { force: true })
  log(JSON.stringify({ state: probed.state, caps: probed.caps }, null, 2))

  log('\n=== plan ===')
  const plan = await manager.plan(created.id)
  if (plan.blocked !== undefined) {
    log('BLOCKED:', plan.blocked)
  } else {
    for (const step of plan.steps) {
      log(`- ${step.id}: ${step.title} | ${step.path} | ~${step.sizeMB}MB | ${step.source ?? ''}`)
      for (const command of step.commands) log(`    $ ${command.script}`)
    }
  }

  if (args.has('--install')) {
    log('\n=== install ===')
    for await (const frame of manager.bootstrap(created.id, {})) {
      if (frame.type === 'step') {
        if (frame.phase === 'start') log(`\n--> ${frame.title}`)
        else if (frame.phase === 'command') log(`$ ${frame.script}`)
        else if (frame.phase === 'log') process.stdout.write(frame.chunk ?? '')
        else if (frame.phase === 'done') log('done.')
        else if (frame.phase === 'fail') log(`FAILED: ${frame.message ?? ''}`)
      } else if (frame.type === 'error') {
        log('ERROR:', frame.message)
      } else if (frame.type === 'done') {
        log('install finished:', frame.message)
      }
    }
  }

  if (args.has('--sync')) {
    log('\n=== config sync ===')
    if (manager.status(created.id).state !== 'running') {
      log('starting the remote dsh first…')
      await manager.start(created.id)
    }
    const preview = await manager.configPreview(created.id)
    log('items:', JSON.stringify(preview.items.map(item => ({ id: item.id, present: item.present, detail: item.detail })), null, 2))
    log('remote before:', JSON.stringify(preview.remote))
    const synced = await manager.syncConfig(created.id, { items: ['providers', 'default-model', 'api-keys'], restart: true })
    log('sync result:', JSON.stringify(synced, null, 2))
    const after = await manager.configPreview(created.id)
    log('remote after:', JSON.stringify(after.remote))
    const running = manager.status(created.id)
    log('state after restart:', running.state, running.url === undefined ? '' : '(url present)')
    if (running.state === 'running' && running.url !== undefined) {
      const { httpStatus } = await import('../lib/manager.js')
      const code = await httpStatus(running.localPort, `/?token=${running.url.split('token=')[1]}`)
      log('remote UI responds with HTTP', code, code === 303 ? '(token redirect: ok)' : '(unexpected)')
    }
  }

  if (args.has('--start') || args.has('--install')) {
    log('\n=== start ===')
    const started = await manager.start(created.id)
    log(JSON.stringify({ state: started.state, url: started.url, localPort: started.localPort, remotePort: started.remotePort, version: started.version }, null, 2))
    log('\n=== stop ===')
    const stopped = await manager.stop(created.id)
    log('state after stop:', stopped.state)
  }
} catch (error) {
  console.error('\nE2E FAILED:', error instanceof Error ? error.stack : error)
  process.exitCode = 1
} finally {
  manager.dispose()
}
