/**
 * dsh-remote — host half. Owns the target registry, the SSH / WSL delivery
 * channels, the remote probe, the no-sudo bootstrap, the loopback tunnel and
 * the /api/dsh-remote route family. The browser half (`./client`) renders the
 * sidebar entry and the remote workspace page.
 *
 * No dsh source changes and no build step: this file and its imports are
 * plain ESM served from the linked package directory.
 * @module dsh-remote
 */

import { TargetManager } from './manager.js'
import { makeRoutes } from './routes.js'

/** Stable cordis plugin name. */
export const name = 'dsh-remote'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/**
 * Mount the manager and its routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  const manager = new TargetManager({ logger: ctx.logger ?? console })

  ctx.effect(() => () => {
    manager.dispose()
  }, 'dsh-remote: manager')

  ctx.effect(() => {
    const disposers = makeRoutes({ manager }).map(route => ctx.webServer.register(route))
    // Warm the discovery cache so the first panel open is instant; a failure
    // here (no ssh config, WSL not installed) must not break activation.
    manager.discover().catch(() => {})
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-remote: routes')
}
