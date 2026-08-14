import { existsSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerApiRoutes } from '../api/index.js'
import { generateCapabilityToken } from '../api/security.js'
import type { ServerContext } from './context.js'
import { registerMutationGuard } from './mutation-guard.js'
import { registerStaticRoute } from './static.js'

const BUILD_COMMAND = 'npm run build --workspace packages/web'

/**
 * Explicit request-size ceiling (the audit's third ask, alongside
 * `mutation-guard.ts`'s Content-Type check) — Fastify's own default, restated
 * here rather than left implicit, so raising or lowering it is a one-line,
 * reviewable change instead of a rediscovery of what the framework happens
 * to default to. Every body this server ever reads is a small JSON object
 * (`/api/label`'s `{ sessionId, label }`; an OTLP export's own batches,
 * which the exporter itself caps); nothing here streams a file upload.
 */
const BODY_LIMIT_BYTES = 1024 * 1024

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The per-process capability token this boot minted (or was handed via
     * `ServerContext.capabilityToken`) — see `api/security.ts`. Read this
     * off the built app to attach it to a mutating request; never logged,
     * never sent anywhere by this app itself.
     */
    capabilityToken: string
  }
}

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
 *
 * Also where the 2026-08-06 audit's app-wide controls land (see
 * `mutation-guard.ts` and `api/security.ts` for the full rationale of each):
 * the loopback `Host` check over every request — the read-only routes
 * `registerApiRoutes` wires up below included, since #235 closed the
 * DNS-rebinding read hole — the Origin and Content-Type checks over every
 * mutating request, an explicit request-size ceiling, and the per-process
 * capability token every mutating route may require.
 */
export function buildApp(ctx: ServerContext): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES })

  // Mutated onto the SAME object the caller handed us, rather than spread
  // into a copy — a copy is exactly the trap prd20's retarget spike found
  // here (Q1, gap e): every route below holds this one reference, so a later
  // re-point of `ctx.repoPath`/`repoName`/`sessionDir` (prd20 ruling 5) is
  // visible to all of them immediately. A copy would have made that silent:
  // the routes would keep reading the object as it looked at boot.
  const capabilityToken = ctx.capabilityToken ?? generateCapabilityToken()
  ctx.capabilityToken = capabilityToken
  app.decorate('capabilityToken', capabilityToken)
  registerMutationGuard(app)

  registerApiRoutes(app, ctx)

  if (ctx.webDistDir && existsSync(ctx.webDistDir)) {
    registerStaticRoute(app, ctx.webDistDir, capabilityToken)
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
