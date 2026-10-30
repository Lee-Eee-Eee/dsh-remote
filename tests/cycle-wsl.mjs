/** Reproduce the stop → start cycle on WSL and dump the remote log. */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TargetManager } from '../lib/manager.js'
import { WslChannel } from '../lib/channel.js'

const distro = process.env.DISTRO ?? 'Debian'
const manager = new TargetManager({ file: join(tmpdir(), `dsh-remote-cycle-${Date.now()}.json`) })
const created = manager.create({ kind: 'wsl', label: `WSL ${distro}`, wsl: { distro } })
const channel = new WslChannel({ wsl: { distro } })
const log = (...parts) => console.log(...parts)

try {
  log('--- first start ---')
  const first = await manager.start(created.id)
  log('state:', first.state, 'url:', first.url)

  log('--- stop ---')
  await manager.stop(created.id)
  log('stopped')

  log('--- second start ---')
  const second = await manager.start(created.id)
  log('state:', second.state, 'url:', second.url)
} catch (error) {
  log('FAILED:', error instanceof Error ? error.message : error)
  log('--- remote state ---')
  const session = `dsh-remote-${created.id.slice(0, 16)}`
  const info = await channel.exec([
    `ls -l "$HOME/.dsh-remote" 2>&1`,
    `echo "--- log ---"`,
    `tail -n 40 "$HOME/.dsh-remote/${created.id}.log" 2>&1`,
    `echo "--- ps ---"`,
    `ps -eo pid,args | grep -v grep | grep 'dsh web' || echo none`,
    `echo "--- pidfile ---"`,
    `cat "$HOME/.dsh-remote/${session}.pid" 2>&1 || echo none`,
  ].join('\n'), { timeoutMs: 20000 })
  log(info.stdout)
  log('stderr:', info.stderr)
} finally {
  manager.dispose()
  process.exit(0)
}
