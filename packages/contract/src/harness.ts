import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import { sessionFileName } from '@rhizomorph/server/log/paths'
import { buildApp } from '@rhizomorph/server/server/build-app'
import { SessionRecorder } from '@rhizomorph/server/server/recorder'
import type { FastifyInstance } from 'fastify'

/**
 * THE CONTRACT HARNESS (prd-24 ruling 1; supersedes #309, closes half of #310).
 *
 * One place that boots the REAL `buildApp`, serves the REAL stamped app shell
 * into the test's document, and hands the REAL web client a fetch backed by
 * `app.inject`. The load-bearing property, stated once here rather than three
 * times: **method, URL, headers and body come from the web module, never from
 * the test.** A test that hand-builds any of those is a unit test wearing a
 * contract test's name — `api/label.test.ts:52`'s exact gap, the one that let
 * #249 ship with every suite green while every real rename 401ed.
 *
 * This existed as three byte-similar copies — `label-seam.test.ts`,
 * `rotate.test.ts`'s seam block, `launch.test.ts`'s seam block — each carrying
 * its own APP_SHELL, transportOnly, tmp dirs and served-page load, and each
 * reaching the server by cross-package relative import, which ruling 1
 * explicitly rejected. The three now live in this package as data-shaped
 * tests over this one harness; a fourth mutating route is a new test file
 * with no new scaffolding.
 */

/** The shell vite emits, minus the bundle: a doctype, a `<head>`, a root div. No token — the server stamps that. */
const APP_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>the Rhizomorph</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

/**
 * The narrowest fetch shape shared by every mutating client's `*FetchLike`:
 * one url, one init, a response with ok/status/json. Each client narrows its
 * own headers further; this transport forwards whatever the client composed,
 * verbatim, and decides nothing.
 */
export interface InjectedInit {
  method: string
  headers?: Record<string, string>
  body?: string
}

export type InjectedFetch = (
  input: string,
  init: InjectedInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface ContractHarness {
  app: FastifyInstance
  /** Pure transport over `app.inject` — forwards exactly what the client composed. */
  fetch: InjectedFetch
  repoPath: string
  sessionDir: string
  /** Tear everything down; call in afterEach. */
  close: () => Promise<void>
}

function defaultSessionEvents(repoPath: string): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: 1000 })
  f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
  return f.all()
}

/**
 * The harness's own live recorder's session id — fixed, so a read contract
 * test that needs to address THIS instance (e.g. an OTLP export's own
 * `instance` resource attribute, `api/otel.ts`'s `INSTANCE_ATTRIBUTE`) can
 * name it without hardcoding a magic literal that only this file actually
 * owns.
 */
export const HARNESS_LIVE_SESSION_ID = '2000'

/**
 * Boots the real app over real temp dirs, loads the REALLY-SERVED page into
 * the jsdom document (so `readCapabilityToken` reads what `static.ts` really
 * stamped — never a hand-made meta tag), and returns the inject-backed fetch.
 *
 * The served-page load asserts the stamp is present before returning: without
 * that, a server that stopped stamping would fail the happy-path test but
 * leave every refusal test passing vacuously on the client's own
 * missing-token throw — the exact vacuity `label-seam.test.ts` documented.
 */
export async function buildContractHarness(
  options: { events?: (repoPath: string) => RhizomorphEvent[] } = {},
): Promise<ContractHarness> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-contract-repo-'))
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-contract-sessions-'))
  const distDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-contract-dist-'))
  await mkdir(sessionDir, { recursive: true })
  await writeFile(path.join(distDir, 'index.html'), APP_SHELL, 'utf8')

  const events = (options.events ?? defaultSessionEvents)(repoPath)
  await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(events), 'utf8')

  const recorder = new SessionRecorder(HARNESS_LIVE_SESSION_ID, path.join(sessionDir, sessionFileName(2000)))
  const app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 9999, webDistDir: distDir })

  const served = await app.inject({ method: 'GET', url: '/' })
  if (served.statusCode !== 200 || !served.body.includes('meta name="rhizomorph-capability"')) {
    throw new Error(
      'the served page carries no stamped capability token — every refusal test downstream would pass vacuously',
    )
  }
  document.open()
  document.write(served.body)
  document.close()

  const fetch: InjectedFetch = async (url, init) => {
    const response = await app.inject({
      method: init.method as 'POST',
      url,
      headers: init.headers,
      payload: init.body,
    })
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      json: async () => response.json() as unknown,
    }
  }

  return {
    app,
    fetch,
    repoPath,
    sessionDir,
    close: async () => {
      await app.close()
      await Promise.all([
        rm(repoPath, { recursive: true, force: true }),
        rm(sessionDir, { recursive: true, force: true }),
        rm(distDir, { recursive: true, force: true }),
      ])
    },
  }
}

/** Remove the stamped token from the page — the "served some other way" case. */
export function stripCapabilityToken(): void {
  document.querySelector('meta[name="rhizomorph-capability"]')?.remove()
}

/** Replace the stamped token with a same-shaped wrong value — exercises the gate's comparison, not the shape check. */
export function tamperCapabilityToken(): void {
  document.querySelector('meta[name="rhizomorph-capability"]')?.setAttribute('content', '0'.repeat(64))
}

/**
 * THE READ AXIS'S OWN SUBSTITUTION POINT (prd-29 w3, #61).
 *
 * Every read seam's default `fetchImpl` is `capabilityRead`
 * (`recordings/capabilityRead.ts`) — it reads the token off the REAL served
 * page itself and calls `globalThis.fetch` directly, so it takes no
 * `fetchImpl` parameter a contract test could hand `h.fetch` to (unlike the
 * mutating five, which build their own header and take a transport
 * parameter). `capabilityRead.test.ts` stubs `globalThis.fetch` for the exact
 * same reason; this is that same technique, wired to the REAL server via
 * `h.fetch` instead of a `vi.fn` mock, so a read contract test can call a
 * client function with NO `fetchImpl` argument at all and still exercise the
 * real `capabilityRead` reading the real page against the real gate.
 *
 * Call in `beforeEach` (after `buildContractHarness()`), and always call the
 * returned restorer in `afterEach` — leaving `globalThis.fetch` patched past
 * one test would leak into whichever test runs next in the same file.
 */
export function routeGlobalFetchThroughHarness(injectedFetch: InjectedFetch): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const headers =
      init?.headers === undefined ? undefined : Object.fromEntries(new Headers(init.headers).entries())
    const result = await injectedFetch(String(input), headers === undefined ? { method } : { method, headers })
    return {
      ok: result.ok,
      status: result.status,
      json: result.json,
    } as unknown as Response
  }) as typeof fetch
  return () => {
    globalThis.fetch = previous
  }
}
