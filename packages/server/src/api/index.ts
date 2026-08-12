import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
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
  // The app's six mutating routes (prd16 rulings 2 and 4; prd1's OTLP inbox)
  // — see `ROUTE_CLASSES` below for the full classification, and `rotate.ts`
  // / `label.ts` for why each of these two is allowed to exist and what
  // still may not.
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
}

/** The three route classes prd-23 ruling 5 declares. */
export type RouteClass = 'gated-mutation' | 'ungated-mutation' | 'read'

export interface RouteClassification {
  method: string
  url: string
  routeClass: RouteClass
}

/**
 * One row per route this app answers to, present and future — the single
 * place prd-23 ruling 5 asks for. `api/route-class-law.test.ts` walks the
 * real Fastify instance `buildApp` produces and fails if any registered
 * route (this table's static `/*` SPA/asset catch-all included — see that
 * test for why it counts as a `read`) is missing from here: incremental
 * adoption is retired, so a new mutating route with no `preHandler` and no
 * row below fails the build rather than being protected because someone
 * remembered.
 */
export const ROUTE_CLASSES: readonly RouteClassification[] = [
  // Gated mutations (3) — each carries `requireCapabilityToken` as a
  // route-local `preHandler` (`api/security.ts`).
  { method: 'POST', url: '/api/label', routeClass: 'gated-mutation' },
  { method: 'POST', url: '/api/rotate', routeClass: 'gated-mutation' },
  { method: 'POST', url: '/api/lab/launch', routeClass: 'gated-mutation' },

  // Ungated mutations (3) — the OTLP inbox, ungated by design (prd-23 ruling
  // 6): an exporter has no channel to learn the capability token at all.
  { method: 'POST', url: '/v1/metrics', routeClass: 'ungated-mutation' },
  { method: 'POST', url: '/v1/logs', routeClass: 'ungated-mutation' },
  { method: 'POST', url: '/v1/traces', routeClass: 'ungated-mutation' },

  // Reads (10).
  { method: 'GET', url: '/api/meta', routeClass: 'read' },
  { method: 'GET', url: '/api/sessions', routeClass: 'read' },
  { method: 'GET', url: '/api/sessions/:id/events', routeClass: 'read' },
  { method: 'GET', url: '/api/stream', routeClass: 'read' },
  { method: 'GET', url: '/api/lanes', routeClass: 'read' },
  { method: 'GET', url: '/api/transcript/:lane', routeClass: 'read' },
  { method: 'GET', url: '/api/lab/checkpoints', routeClass: 'read' },
  { method: 'GET', url: '/api/lab/experiments', routeClass: 'read' },
  { method: 'GET', url: '/api/lab/estimate', routeClass: 'read' },
  { method: 'GET', url: '/api/doctor', routeClass: 'read' },

  // The static dashboard / SPA-fallback catch-all `server/static.ts` (or its
  // missing-build placeholder) registers directly on `buildApp`'s instance,
  // outside `registerApiRoutes` — still a real registered route the law
  // walks, and a plain `GET` is a `read` regardless of which handler answers
  // it.
  { method: 'GET', url: '/*', routeClass: 'read' },
]
