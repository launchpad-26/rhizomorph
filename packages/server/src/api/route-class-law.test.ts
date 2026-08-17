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
    // `/api/lane-index` and `/api/lane-index/:handle`.
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

    expect(unclassified).toEqual([{ method: 'POST', url: '/api/not-a-real-route' }])

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
})
