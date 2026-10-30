/**
 * The /api/dsh-remote route family — target CRUD, discovery, probe, install
 * plan (NDJSON), start/stop, and status. Every route is loopback-fenced: these
 * endpoints start remote processes and open tunnels, so a LAN-exposed dsh web
 * must never serve them.
 *
 * Ids travel as the `?id=` query parameter rather than a path segment so every
 * route is one `exact` registration (the webserver's route registry is keyed
 * by (kind, path) and rejects duplicates).
 * @module dsh-remote/routes
 */

import { asObject, openNdjson, readJsonBody, writeJson } from './http.js'
import { isLoopbackRequest } from './loopback.js'

/** Route prefix (each route below is an exact path under it). */
export const API_BASE = '/api/dsh-remote'

/**
 * Build every route for the manager.
 * @param {{manager: import('./manager.js').TargetManager}} deps - manager.
 * @returns {Array<{kind: 'exact', path: string, handler: Function}>} routes.
 */
export function makeRoutes({ manager }) {
  /** Guard one request: fence, then method. */
  const allow = (req, res, methods) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    const method = req.method ?? 'GET'
    if (!methods.includes(method)) {
      writeJson(res, 405, { error: `method not allowed: ${method}` })
      return false
    }
    return true
  }

  const idOf = (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('id')
    return id === null || id === '' ? undefined : id
  }

  /**
   * The host name the embedding page uses (`window.location.hostname`). The
   * remote has to advertise exactly this authority, because its auth cookie is
   * `SameSite=Strict` and a browser compares sites, not ports.
   */
  const hostOf = (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = url.searchParams.get('host')
    return host === null || host === '' ? undefined : host
  }

  const fail = (res, error) => {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 400, { error: message })
  }

  return [
    {
      kind: 'exact',
      path: `${API_BASE}/targets`,
      handler: async (req, res) => {
        if (!allow(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.searchParams.get('refresh') === '1') await manager.discover({ force: true })
            writeJson(res, 200, manager.list())
            return
          }
          const body = asObject(await readJsonBody(req)) ?? {}
          if (method === 'POST') {
            writeJson(res, 201, { target: manager.create(body) })
            return
          }
          const id = idOf(req)
          if (id === undefined) {
            writeJson(res, 400, { error: 'id query parameter is required' })
            return
          }
          if (method === 'PATCH') {
            const updated = manager.update(id, body)
            if (updated === undefined) {
              writeJson(res, 404, { error: 'target not found' })
              return
            }
            writeJson(res, 200, { target: updated })
            return
          }
          if (!manager.remove(id)) {
            writeJson(res, 404, { error: 'target not found' })
            return
          }
          writeJson(res, 200, { ok: true })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/discover`,
      handler: async (req, res) => {
        if (!allow(req, res, ['GET', 'POST'])) return
        try {
          const discovery = await manager.discover({ force: true })
          writeJson(res, 200, { discovery })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/status`,
      handler: async (req, res) => {
        if (!allow(req, res, ['GET'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 200, manager.list())
          return
        }
        const status = manager.status(id)
        if (status === undefined) {
          writeJson(res, 404, { error: 'target not found' })
          return
        }
        writeJson(res, 200, { target: status })
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/probe`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        try {
          const status = await manager.probe(id, { force: true })
          writeJson(res, 200, { target: status })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/plan`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        try {
          const plan = await manager.plan(id)
          writeJson(res, 200, { plan })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/bootstrap`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        const body = asObject(await readJsonBody(req)) ?? {}
        const skip = Array.isArray(body.skip) ? body.skip.filter(item => typeof item === 'string') : []
        const stream = openNdjson(res)
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        try {
          for await (const frame of manager.bootstrap(id, { skip, signal: controller.signal })) {
            if (stream.closed()) break
            stream.write(frame)
          }
        } catch (error) {
          stream.write({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        } finally {
          stream.end()
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/local-config`,
      handler: async (req, res) => {
        if (!allow(req, res, ['GET'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        try {
          writeJson(res, 200, { config: await manager.configPreview(id) })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/sync-config`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        const body = asObject(await readJsonBody(req)) ?? {}
        const items = Array.isArray(body.items) ? body.items.filter(item => typeof item === 'string') : undefined
        try {
          const result = await manager.syncConfig(id, { items, restart: body.restart === true, publicHost: hostOf(req) })
          if (result.ok !== true && (result.wrote ?? []).length === 0) {
            writeJson(res, 400, { error: result.message ?? '没有可写入的配置项。' })
            return
          }
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/client-report`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const body = asObject(await readJsonBody(req)) ?? {}
        try {
          manager.recordClientReport(body)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/start`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        try {
          const status = await manager.start(id, { publicHost: hostOf(req) })
          writeJson(res, 200, { target: status })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/restart`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        try {
          const status = await manager.restart(id, { publicHost: hostOf(req) })
          writeJson(res, 200, { target: status })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/stop`,
      handler: async (req, res) => {
        if (!allow(req, res, ['POST'])) return
        const id = idOf(req)
        if (id === undefined) {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        try {
          const status = await manager.stop(id)
          writeJson(res, 200, { target: status })
        } catch (error) {
          fail(res, error)
        }
      },
    },
  ]
}
