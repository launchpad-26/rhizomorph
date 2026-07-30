import { existsSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerApiRoutes } from '../api/index.js'
import type { ServerContext } from './context.js'
import { registerStaticRoute } from './static.js'

export function buildApp(ctx: ServerContext): FastifyInstance {
  const app = Fastify()

  registerApiRoutes(app, ctx)

  if (ctx.webDistDir && existsSync(ctx.webDistDir)) {
    registerStaticRoute(app, ctx.webDistDir)
  }

  return app
}
