import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp, type RegisteredRoute } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { ROUTE_CLASSES, type RouteClassification } from './index.js'

/**
 * Fastify auto-registers a `HEAD` mirror for every `GET` (`exposeHeadRoutes`,
 * on by default) — same handler, same `preHandler`s, same security posture as
 * its `GET`. Classifying it as a fourth, separate thing would double-count
 * every read for no trust-boundary reason, so the law ignores it rather than
 * declaring a class that means nothing.
 */
function isAutoHead(route: RegisteredRoute): boolean {
  return route.method === 'HEAD'
}

function classify(route: RegisteredRoute, table: readonly RouteClassification[]): RouteClassification | undefined {
  return table.find((entry) => entry.method === route.method && entry.url === route.url)
}

/** Whether a classification is one of the two gated postures the presence law covers. */
function isGated(entry: RouteClassification): boolean {
  return entry.routeClass === 'gated-mutation' || entry.routeClass === 'gated-read'
}

/**
 * THE GATE-PRESENCE LAW itself (prd-29 ruling 2 / ADR-0024), as one pure
 * function both the real-app walk and the synthetic bite-test call — the
 * mechanism that guards the routes is the same one proven able to fail.
 *
 * Returns every `gated-*` row whose actually-registered route does NOT carry
 * the capability gate (`hasCapabilityGate`), plus every row the table calls a
 * plain `read`/`ungated-mutation` that unexpectedly DOES — a stray gate on
 * `GET /*` is as much a defect as a missing one on `/api/transcript/:lane`. A
 * row with no registered route at all is left to the stale-row law above; this
 * one speaks only about routes that exist.
 */
function gatePresenceViolations(
  routes: readonly RegisteredRoute[],
  table: readonly RouteClassification[],
): { method: string; url: string; expectedGate: boolean; actualGate: boolean }[] {
  const out: { method: string; url: string; expectedGate: boolean; actualGate: boolean }[] = []
  for (const route of routes) {
    const entry = classify(route, table)
    if (entry === undefined) continue
    const expectedGate = isGated(entry)
    if (route.hasCapabilityGate !== expectedGate) {
      out.push({ method: route.method, url: route.url, expectedGate, actualGate: route.hasCapabilityGate })
    }
  }
  return out
}

describe('the route-class law (prd-23 ruling 5)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-class-law-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeCtx() {
    return {
      repoPath: '/repo',
      repoName: 'repo',
      sessionDir: dir,
      recorder: new SessionRecorder('1000', sessionFilePath(dir, '1000')),
    }
  }

  it('classifies every route this app registers, and only this many', async () => {
    const app = buildApp(makeCtx())
    // `api/otel.ts`'s three routes live inside their own `app.register(...)`
    // plugin — the plugin queue only actually runs its routes once `ready()`
    // resolves, so reading `registeredRoutes` any earlier would silently miss
    // them and this law would walk vacuously over the other 14.
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))
    const unclassified = routes.filter((route) => classify(route, ROUTE_CLASSES) === undefined)

    expect(unclassified).toEqual([])
    // A count pinned independently of `ROUTE_CLASSES.length` itself: a walk
    // that silently matched zero real routes, or a classification table
    // quietly emptied, must not both agree and pass anyway. This repo has
    // had two laws walk vacuously before.
    // 23 -> 25: the lane index's two reads (prd-31 ruling 5, #556) —
    // `/api/lane-index` and `/api/lane-index/:handle`. prd-29 ruling 7 (#58,
    // #59) reclassifies six existing rows to `gated-read` and adds none, so
    // the count is unchanged.
    expect(routes.length).toBe(25)
    expect(ROUTE_CLASSES.length).toBe(25)

    await app.close()
  })

  it('bites: a real route registered with no row in the table fails the walk', async () => {
    const app = buildApp(makeCtx())
    // Registered directly on the real instance, exactly the way any future
    // route would be — proving the law reads the app, not a list of what is
    // merely expected to exist.
    app.post('/api/not-a-real-route', async () => ({}))
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))
    const unclassified = routes.filter((route) => classify(route, ROUTE_CLASSES) === undefined)

    expect(unclassified).toEqual([{ method: 'POST', url: '/api/not-a-real-route', hasCapabilityGate: false }])

    await app.close()
  })

  it('every row in the table is still an actually-registered route — a stale row cannot hide behind a table that was never checked both ways', async () => {
    const app = buildApp(makeCtx())
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))
    const stale = ROUTE_CLASSES.filter(
      (entry) => !routes.some((route) => route.method === entry.method && route.url === entry.url),
    )

    expect(stale).toEqual([])

    await app.close()
  })

  it('the gate-presence law holds: every gated row carries its gate, and no read carries one (prd-29 ruling 2)', async () => {
    const app = buildApp(makeCtx())
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))

    // Every `gated-*` row's real route holds the capability gate, and every
    // plain `read`/`ungated-mutation` holds none. Deleting a `preHandler` from
    // any of the nineteen gated routes turns this red — that is the law biting.
    expect(gatePresenceViolations(routes, ROUTE_CLASSES)).toEqual([])

    // A count pinned independently, so the walk cannot pass vacuously by
    // matching zero gated routes: six gated mutations + seven gated reads
    // (prd-29 wave 1) + four gated reads (prd-29 wave 1b, ruling 7, #58) +
    // two gated reads (prd-29 wave 2a, ruling 7, #59). If this number and the
    // walk above disagree with the table, they cannot both pass.
    const gatedFound = routes.filter((route) => {
      const entry = classify(route, ROUTE_CLASSES)
      return entry !== undefined && isGated(entry) && route.hasCapabilityGate
    })
    expect(gatedFound.length).toBe(19)

    await app.close()
  })

  it('GET /* stays tokenless — the bootstrap keeps no gate (prd-29 ruling 1)', async () => {
    const app = buildApp(makeCtx())
    await app.ready()

    const catchAll = app.registeredRoutes.find((route) => route.method === 'GET' && route.url === '/*')
    expect(catchAll).toBeDefined()
    expect(catchAll?.hasCapabilityGate).toBe(false)

    await app.close()
  })

  it('bites: a gated-read row whose route lacks its gate is a violation, and a present gate is clean', () => {
    // Runs the REAL predicate the walk above uses — not a re-implementation —
    // against a hand-built routing table, so it proves the law can distinguish
    // a missing gate from a present one rather than passing on everything.
    const table: RouteClassification[] = [{ method: 'GET', url: '/api/sessions', routeClass: 'gated-read' }]

    const missing: RegisteredRoute[] = [{ method: 'GET', url: '/api/sessions', hasCapabilityGate: false }]
    expect(gatePresenceViolations(missing, table)).toEqual([
      { method: 'GET', url: '/api/sessions', expectedGate: true, actualGate: false },
    ])

    const present: RegisteredRoute[] = [{ method: 'GET', url: '/api/sessions', hasCapabilityGate: true }]
    expect(gatePresenceViolations(present, table)).toEqual([])

    // …and a stray gate on a plain read is caught too, not only a missing one.
    const strayTable: RouteClassification[] = [{ method: 'GET', url: '/*', routeClass: 'read' }]
    const stray: RegisteredRoute[] = [{ method: 'GET', url: '/*', hasCapabilityGate: true }]
    expect(gatePresenceViolations(stray, strayTable)).toEqual([
      { method: 'GET', url: '/*', expectedGate: false, actualGate: true },
    ])
  })
})
