import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import { registerLabelRoute } from './label.js'
import { registerLabRoutes } from './lab.js'
import { registerLanesRoute } from './lanes.js'
import { registerMetaRoute } from './meta.js'
import { registerOtelRoutes } from './otel.js'
import { registerRotateRoute } from './rotate.js'
import { registerSessionsRoutes } from './sessions.js'
import { registerStreamRoute } from './stream.js'
import { registerTranscriptRoute } from './transcript.js'

export function registerApiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerMetaRoute(app, ctx)
  registerSessionsRoutes(app, ctx)
  registerStreamRoute(app, ctx)
  registerOtelRoutes(app, ctx)
  registerLanesRoute(app, ctx)
  registerTranscriptRoute(app, ctx)
  // The app's two mutating routes (prd16 rulings 2 and 4) — see `rotate.ts`
  // and `label.ts` for why each is allowed to exist and what still may not.
  registerRotateRoute(app, ctx)
  registerLabelRoute(app, ctx)
  // Read-only routes over the laboratory's checkpoint/experiment slice
  // (prd14 wave 1) — see `lab.ts`'s own doc for why this never imports
  // `server/src/lab/` directly.
  registerLabRoutes(app, ctx)
}
