/**
 * Small HTTP helpers shared by the route family: a bounded JSON body reader,
 * a JSON writer, and an NDJSON streaming writer used by the bootstrap plan
 * stream.
 * @module dsh-remote/http
 */

/** Default JSON body cap. */
const DEFAULT_MAX_BYTES = 64 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {{maxBytes?: number}} [options] - body cap.
 * @returns {Promise<unknown | null>} parsed body, or null when absent/invalid.
 */
export async function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Narrow a value to a plain JSON object. */
export function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} body - JSON-serializable payload.
 */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Open an NDJSON response stream (`application/x-ndjson`), used for the
 * install plan and its live log. The client reads it with a
 * `ReadableStream` reader and appends one frame at a time.
 * @param {import('node:http').ServerResponse} res - response.
 * @returns {{write: (frame: unknown) => void, end: () => void, closed: () => boolean}} stream handle.
 */
export function openNdjson(res) {
  let closed = false
  const onClose = () => { closed = true }
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  res.on('close', onClose)
  return {
    write(frame) {
      if (closed || res.writableEnded) return
      res.write(JSON.stringify(frame) + '\n')
    },
    end() {
      if (closed || res.writableEnded) return
      res.end()
    },
    closed: () => closed || res.writableEnded,
  }
}
