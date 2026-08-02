import { existsSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerApiRoutes } from '../api/index.js'
import type { ServerContext } from './context.js'
import { registerStaticRoute } from './static.js'

const BUILD_COMMAND = 'npm run build --workspace packages/web'

function missingBuildHtml(webDistDir: string | undefined): string {
  const where = webDistDir ? `<p>Expected it at <code>${webDistDir}</code>.</p>` : ''
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Rhizomorph — web build missing</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5;">
<h1>The dashboard hasn't been built yet</h1>
<p>The Rhizomorph API is running, but <code>packages/web</code> has no build output to serve.</p>
<p>Run <code>${BUILD_COMMAND}</code>, then reload this page.</p>
${where}
</body>
</html>`
}

/**
 * Wires up the static dashboard when it's built, or a loud, explicit
 * placeholder when it isn't — so a stranger who skipped the build step sees
 * "run this command" instead of Fastify's bare `{"message":"Route GET:/ not
 * found"}`.
 */
export function buildApp(ctx: ServerContext): FastifyInstance {
  const app = Fastify()

  registerApiRoutes(app, ctx)

  if (ctx.webDistDir && existsSync(ctx.webDistDir)) {
    registerStaticRoute(app, ctx.webDistDir)
  } else {
    console.warn(
      `[rhizomorph] web build not found${ctx.webDistDir ? ` at ${ctx.webDistDir}` : ''} — run \`${BUILD_COMMAND}\` to build the dashboard.`,
    )
    const html = missingBuildHtml(ctx.webDistDir)
    app.get('/*', async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.send(html)
    })
  }

  return app
}
