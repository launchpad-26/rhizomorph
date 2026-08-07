import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
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
 * The `<meta>` name the capability token is delivered under (issue #249;
 * `docs/adr/0012-in-band-capability-token-delivery.md`). Read back by
 * `packages/web/src/recordings/capability.ts` — keep the two in sync; there
 * is no shared package between server and web to import a single constant
 * from (web stays browser-safe, server is not).
 */
const CAPABILITY_META_NAME = 'rhizomorph-capability'

/**
 * Stamps the per-process capability token into `index.html`'s `<head>` so
 * the browser has a value to send back on `POST /api/label` — the one
 * channel that ever hands it out (see the ADR above for why in-band, and
 * what that costs). Every token this process mints is 64 hex characters
 * (`generateCapabilityToken`, `api/security.ts`), so no HTML-attribute
 * escaping is needed here; a caller-supplied `ServerContext.capabilityToken`
 * (tests only) is expected to hold to the same shape.
 */
function injectCapabilityMeta(html: string, capabilityToken: string): string {
  const tag = `<meta name="${CAPABILITY_META_NAME}" content="${capabilityToken}">`
  return html.includes('</head>') ? html.replace('</head>', `  ${tag}\n  </head>`) : `${tag}\n${html}`
}

/**
 * Serves `packages/web/dist` as a single-page app: a request for a real file
 * in dist gets that file, anything else (a client-side route) falls back to
 * index.html. Only wired in when the directory actually exists — there is
 * no `web` dependency at build time, just a dist folder that may or may not
 * be there yet.
 *
 * Every response that is `index.html` — whether requested directly or
 * reached via the SPA fallback — is read and stamped with the capability
 * token rather than streamed verbatim; every other file streams unmodified.
 */
export function registerStaticRoute(app: FastifyInstance, distDir: string, capabilityToken: string): void {
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

    if (path.extname(filePath) === '.html') {
      const html = readFileSync(filePath, 'utf8')
      return reply.send(injectCapabilityMeta(html, capabilityToken))
    }

    return reply.send(createReadStream(filePath))
  })
}
