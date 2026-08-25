import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import { registerConciergeCloneRoute, registerConciergeLaunchRoute, registerConciergeReposRoute } from './concierge.js'
import { registerDoctorRoute } from './doctor.js'
import { registerLabelRoute } from './label.js'
import { registerLabRoutes } from './lab.js'
import { registerLaneIndexRoutes } from './lane-index.js'
import { registerLanesRoute } from './lanes.js'
import { registerMetaRoute } from './meta.js'
import { registerOtelRoutes } from './otel.js'
import { registerRetargetRoute } from './retarget.js'
import { registerRotateRoute } from './rotate.js'
import { registerSessionPreviewRoute } from './session-preview.js'
import { registerSessionsRoutes } from './sessions.js'
import { registerStreamRoute } from './stream.js'
import { registerTranscriptRoute } from './transcript.js'

export function registerApiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerMetaRoute(app, ctx)
  registerSessionsRoutes(app, ctx)
  registerStreamRoute(app, ctx)
  registerOtelRoutes(app, ctx)
  registerLanesRoute(app, ctx)
  // The lane index (prd-31 ruling 5, #556) — what makes `/lane/:handle`
  // readable after the worktree is gone. Registered beside `/api/lanes`
  // because it answers the neighbouring question ("what has this lane ever
  // done", against the manifest's "what is this lane allowed to touch"), and
  // never merged into it: the manifest is dispatch's live declaration, this is
  // the log's own history, and one route returning both would tie a durable
  // read to a file that only exists mid-wave.
  registerLaneIndexRoutes(app, ctx)
  registerTranscriptRoute(app, ctx)
  // A session's first words (prd20 w6) — the read-only companion to the
  // transcript tail, sharing its attribution and its bounded-read shape.
  registerSessionPreviewRoute(app, ctx)
  // The app's ten mutating routes (prd16 rulings 2 and 4; prd1's OTLP inbox;
  // prd-20's two concierge powers and its repo switch) — see `ROUTE_CLASSES`
  // below for the full classification, and `rotate.ts` / `label.ts` for why
  // each of these two is allowed to exist and what still may not.
  registerRotateRoute(app, ctx)
  registerLabelRoute(app, ctx)
  // prd-20 ruling 5's repo switch (#389) — the session boundary drawn across
  // two repos, assembling #385–#388. Registered beside rotation because it is
  // the same hand: see `retarget.ts`'s own doc for the order it runs in, and
  // `retarget-law.test.ts` for the clause that keeps it a human's act.
  registerRetargetRoute(app, ctx)
  // Read-only routes over the laboratory's checkpoint/experiment slice
  // (prd14 wave 1) — see `lab.ts`'s own doc for why this never imports
  // `server/src/lab/` directly.
  registerLabRoutes(app, ctx)
  // Read-only preflight reusing the CLI doctor's own check functions
  // (prd-19 ruling 5) — see `doctor.ts`'s own doc for which checks it drops
  // and why.
  registerDoctorRoute(app, ctx)
  // The concierge's declared importer (prd-20 ruling 1 / ADR-0019) — the
  // namespace law allows only this one file to reach `concierge/`, so both
  // its routes are registered through it: read-only repo discovery for the
  // setup wizard's picker (ruling 5), and clone-by-URL (#262), the app's
  // THIRD mutating route. See `concierge.ts`'s own doc for each.
  registerConciergeReposRoute(app, ctx)
  registerConciergeCloneRoute(app, ctx)
  // The concierge's second power (#264): launch/relaunch-with-continuity the
  // conductor. Also gated through `api/concierge.ts` — see its own doc.
  registerConciergeLaunchRoute(app, ctx)
}

/**
 * The four route classes: prd-23 ruling 5's three, plus `gated-read`
 * (prd-29 ruling 1 / ADR-0024) — a read that answers only the capability
 * token's holder. `read` now means specifically a TOKENLESS read: today only
 * `GET /*`, the bootstrap the in-band token delivery (ADR-0012) depends on,
 * and the reads prd-29 defers to wave 2 (`/api/meta`, `/api/doctor`,
 * `/api/stream`).
 */
export type RouteClass = 'gated-mutation' | 'ungated-mutation' | 'gated-read' | 'read'

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
  // Gated mutations (6) — each carries `requireCapabilityToken` as a
  // route-local `preHandler` (`api/security.ts`).
  { method: 'POST', url: '/api/label', routeClass: 'gated-mutation' },
  { method: 'POST', url: '/api/rotate', routeClass: 'gated-mutation' },
  // prd-20 ruling 5's repo switch: the same hand as rotation, drawn across two
  // repos' session directories (#389).
  { method: 'POST', url: '/api/retarget', routeClass: 'gated-mutation' },
  { method: 'POST', url: '/api/lab/launch', routeClass: 'gated-mutation' },
  // The concierge's two granted powers (prd-20 ruling 1 / ADR-0019): clone a
  // repo into its own namespace, and launch/relaunch the conductor. Both are
  // "never from a collector, never from a poll" — the gate is the grant.
  { method: 'POST', url: '/api/concierge/clone', routeClass: 'gated-mutation' },
  { method: 'POST', url: '/api/concierge/launch', routeClass: 'gated-mutation' },

  // Ungated mutations (4) — the OTLP inbox, ungated by design (prd-23 ruling
  // 6): an exporter has no channel to learn the capability token at all.
  // `POST /` is the bare-path fallback ADR-0018 adds for an exporter that
  // never appends `/v1/<signal>` to its configured endpoint.
  { method: 'POST', url: '/v1/metrics', routeClass: 'ungated-mutation' },
  { method: 'POST', url: '/v1/logs', routeClass: 'ungated-mutation' },
  { method: 'POST', url: '/v1/traces', routeClass: 'ungated-mutation' },
  { method: 'POST', url: '/', routeClass: 'ungated-mutation' },

  // Gated reads (11) — prd-29 wave 1's keystone (ruling 1 / ADR-0024) plus
  // wave 1b's four late arrivals (ruling 7, #58): the reads that postdated
  // the PRD's route math. Each carries `requireCapabilityToken` as a
  // route-local `preHandler`, exactly as the gated mutations do; the
  // gate-presence law (ADR-0024) fails the build if any of these rows loses
  // its gate.
  { method: 'GET', url: '/api/sessions', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/sessions/:id/events', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/lanes', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/transcript/:lane', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/lab/checkpoints', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/lab/experiments', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/lab/estimate', routeClass: 'gated-read' },
  // prd-31 ruling 5's durability read — the log's own history, never a worktree's.
  { method: 'GET', url: '/api/lane-index', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/lane-index/:handle', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/session-preview/:sessionId', routeClass: 'gated-read' },
  { method: 'GET', url: '/api/concierge/repos', routeClass: 'gated-read' },

  // Tokenless reads (3, plus the static catch-all below). `/api/meta`,
  // `/api/doctor` and `/api/stream` gate in wave 2 (prd-29 sequencing) so no
  // consumer outside the SPA breaks mid-milestone.
  { method: 'GET', url: '/api/meta', routeClass: 'read' },
  { method: 'GET', url: '/api/stream', routeClass: 'read' },
  { method: 'GET', url: '/api/doctor', routeClass: 'read' },

  // The static dashboard / SPA-fallback catch-all `server/static.ts` (or its
  // missing-build placeholder) registers directly on `buildApp`'s instance,
  // outside `registerApiRoutes` — still a real registered route the law
  // walks, and a plain `GET`. It stays `read` FOREVER (prd-29 ruling 1): it is
  // the tokenless bootstrap the browser's first paint and `rhizomorph rotate`'s
  // scrape both read the in-band token from (ADR-0012). Gating it cannot stop
  // a local process and would break that bootstrap — prd-29's non-goals say so.
  { method: 'GET', url: '/*', routeClass: 'read' },
]
