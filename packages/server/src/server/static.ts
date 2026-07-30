import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serves `packages/web/dist` as a single-page app: a request for a real file
 * in dist gets that file, anything else (a client-side route) falls back to
 * index.html. Only wired in when the directory actually exists — there is
 * no `web` dependency at build time, just a dist folder that may or may not
 * be there yet.
 */
export function registerStaticRoute(app: FastifyInstance, distDir: string): void {
  const root = path.resolve(distDir)

  app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    const requested = path.resolve(root, request.params['*'] || 'index.html')
    if (!requested.startsWith(root)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    let filePath = requested
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = path.join(root, 'index.html')
    }
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'not found' })
    }

    reply.header('Content-Type', MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream')
    return reply.send(createReadStream(filePath))
  })
}
