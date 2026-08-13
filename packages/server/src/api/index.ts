import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import { registerConciergeCloneRoute, registerConciergeReposRoute } from './concierge.js'
import { registerDoctorRoute } from './doctor.js'
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
  // prd16's two mutating routes (rulings 2 and 4) — see `rotate.ts` and
  // `label.ts` for why each is allowed to exist and what still may not.
  registerRotateRoute(app, ctx)
  registerLabelRoute(app, ctx)
  // Read-only routes over the laboratory's checkpoint/experiment slice
  // (prd14 wave 1) — see `lab.ts`'s own doc for why this never imports
  // `server/src/lab/` directly.
  registerLabRoutes(app, ctx)
  // Read-only preflight reusing the CLI doctor's own check functions
  // (prd-19 ruling 5) — see `doctor.ts`'s own doc for which checks it drops
  // and why.
  registerDoctorRoute(app, ctx)
  // The concierge's declared importer (prd-20 ruling 1 / ADR-0014) — the
  // namespace law allows only this one file to reach `concierge/`, so both
  // its routes are registered through it: read-only repo discovery for the
  // setup wizard's picker (ruling 5), and clone-by-URL (#262), the app's
  // THIRD mutating route. See `concierge.ts`'s own doc for each.
  registerConciergeReposRoute(app, ctx)
  registerConciergeCloneRoute(app, ctx)
}
