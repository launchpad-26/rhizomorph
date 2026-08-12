import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// Deliberate, test-only cross-package edge, exactly as `recordings/
// label-seam.test.ts` documents it: the seam the last block of this file
// exists to prove is web↔server, so the server's REAL modules come in by
// path. The mutating-calls law's sweep excludes test files; no non-test file
// under packages/web/src may import server source.
import { sessionFileName } from '../../../../server/src/log/paths.js'
import { buildApp } from '../../../../server/src/server/build-app.js'
import { SessionRecorder } from '../../../../server/src/server/recorder.js'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import { LAUNCH_URL, requestLaunch, type LaunchFetchLike, type LaunchOutcome } from './launch.js'

/**
 * The app's third mutating call. Same discipline as `replay/rotate.test.ts`
 * and `recordings/label.test.ts`: never believe an answer it doesn't
 * recognise, and never throw away a partial outcome — arms that already
 * dispatched already spent real money.
 *
 * Since #234 it must also carry the per-process capability token, because the
 * route now requires it. The last block is the seam test that keeps that
 * widening honest: real served page, real client, real gate — the arrangement
 * whose absence let #249 ship a route no caller could authenticate to.
 */

const TEST_TOKEN = 'test-capability-token'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249, ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): LaunchFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

const OUTCOME: LaunchOutcome = {
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      model: 'opus',
      briefProvided: true,
      forkId: 'fork-abc',
      laneHandle: 'fork-abc-arm-1',
      worktreePath: '/data/lab/worktrees/fork-abc-arm-1',
      launched: true,
    },
  ],
  failed: null,
}

describe('requestLaunch', () => {
  it('asks the one route, with the one verb, a JSON body naming lane, checkpointId and arms, and the capability header', async () => {
    const fetchImpl = vi.fn(answering(OUTCOME))
    const request = { lane: 'feature', checkpointId: 'ckpt-1', arms: [{ model: 'opus', brief: 'try X' }] }

    const outcome = await requestLaunch(request, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(LAUNCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify(request),
    })
    expect(outcome).toEqual(OUTCOME)
  })

  /**
   * ADR-0012's known dev-mode gap, made honest rather than closed. Under `npm
   * run dev:web` vite serves `index.html` itself, so the injection never runs
   * and this page has no token. The operator must read what is missing and
   * what to run — especially here, where the alternative is a launch dialog
   * showing a bare 401 about a header they cannot supply.
   */
  it('refuses before the wire when the page carries no token, naming what is missing and what to run', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    const content = meta?.getAttribute('content') ?? null
    meta?.remove()
    const fetchImpl = vi.fn(answering(OUTCOME))

    try {
      const failure = await requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl).catch(
        (err: unknown) => err,
      )

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('this page carries no capability token')
      expect(message).toContain('dev:web')
      expect(message).toContain('npm run build')
      // Nothing was dispatched — a launch that cannot be authorised is not sent.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      const restored = document.createElement('meta')
      restored.setAttribute('name', CAPABILITY_META_NAME)
      restored.setAttribute('content', content ?? TEST_TOKEN)
      document.head.appendChild(restored)
    }
  })

  it("surfaces the instrument's own refusal, so the launch dialog can show it", async () => {
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)
    await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl)).rejects.toThrow(
      'could not launch — this server is replaying a session record',
    )
  })

  /**
   * Same staleness as `replay/rotate.ts`, and it costs more here: by the time
   * this refusal appears the operator has configured every arm and read a
   * spend estimate, so a message that doesn't say "reload" makes them do all
   * of it again to find out.
   */
  it('tells the operator to reload when the token on this page outlived the server that minted it', async () => {
    const fetchImpl = answering(
      { error: 'missing or invalid x-rhizomorph-capability header — this route requires the per-process capability token' },
      401,
    )

    const failure = await requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl).catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('missing or invalid x-rhizomorph-capability')
    expect(message).toMatch(/reload this page/i)
    expect(message).toMatch(/every time it starts/i)
  })

  it('falls back to the status when a refusal carries no message', async () => {
    await expect(
      requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, answering(null, 500)),
    ).rejects.toThrow('the server answered 500')
  })

  it('says the instrument is unreachable rather than swallowing a network failure', async () => {
    const fetchImpl: LaunchFetchLike = async () => {
      throw new Error('NetworkError')
    }
    await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl)).rejects.toThrow(
      'could not reach the instrument: NetworkError',
    )
  })

  it('refuses to report a launch from an answer that is not one', async () => {
    for (const payload of [{}, { parentLane: 'x' }, 'ok', { parentLane: 'x', checkpointId: 'y', arms: 'nope', failed: null }]) {
      await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, answering(payload))).rejects.toThrow(
        'the instrument answered something other than a launch result',
      )
    }
  })

  it('reports a partial outcome (some arms dispatched, one failed) rather than throwing it away', async () => {
    const partial: LaunchOutcome = {
      ...OUTCOME,
      failed: { arm: 2, error: 'workmux add fork-abc-arm-2 -b failed: tmux server not running' },
    }
    const outcome = await requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}, {}] }, answering(partial))
    expect(outcome.arms).toHaveLength(1)
    expect(outcome.failed).toEqual({ arm: 2, error: 'workmux add fork-abc-arm-2 -b failed: tmux server not running' })
  })
})

/**
 * THE LAUNCH SEAM (#234, in the shape #249's own acceptance criterion took).
 *
 * Every test above this line is green whether or not the two halves agree: the
 * meta tag is hand-built and the transport is a double. That is exactly the
 * arrangement under which #249 shipped a gated route its only caller could not
 * authenticate to, for weeks, looking like a UI bug.
 *
 * This block crosses the wire for real: the REAL `buildApp` serves the REAL
 * app shell (stamped by `server/static.ts` at serve time), the REAL
 * `readCapabilityToken` reads it off the REAL document, and the REAL
 * `requestLaunch` composes the request the REAL `requireCapabilityToken`
 * judges. Nothing here writes a meta tag, names the header, or reads
 * `app.capabilityToken`.
 *
 * What it deliberately does NOT do is complete a launch: that forks a real
 * worktree and dispatches a real agent that spends real money, which is not a
 * thing a unit suite may do. The request carries a body the route's own
 * validation refuses, so a **400 proves the token was accepted** — the gate
 * runs as a `preHandler`, strictly before the handler that answers 400 exists
 * to be reached, so the two answers cannot be confused. `api/lab.test.ts`
 * covers the dispatch itself against a stubbed `exec`.
 */
describe('the launch seam: served page → real client → real gate (#234)', () => {
  /** The shell vite emits, minus the bundle. No token — the server stamps that. */
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

  /** Pure transport: forwards exactly what the client composed, answers exactly what the app said. */
  function transportOnly(app: FastifyInstance): LaunchFetchLike {
    return async (url, init) => {
      const response = await app.inject({ method: init.method, url, headers: init.headers, payload: init.body })
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => response.json() as unknown,
      }
    }
  }

  /** A request the route's OWN validation refuses — so the answer distinguishes the gate from the handler. */
  const MALFORMED = { lane: '', checkpointId: 'ckpt-1', arms: [{}] }

  let repoPath: string
  let sessionDir: string
  let distDir: string
  let app: FastifyInstance

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-launch-seam-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-launch-seam-dir-'))
    distDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-launch-seam-dist-'))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(path.join(distDir, 'index.html'), APP_SHELL, 'utf8')

    const recorder = new SessionRecorder('1000', path.join(sessionDir, sessionFileName(1000)))
    app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 9999, webDistDir: distDir })

    const served = await app.inject({ method: 'GET', url: '/' })
    expect(served.statusCode).toBe(200)
    expect(served.body, 'the served page must carry the stamped token before these tests mean anything').toContain(
      `meta name="${CAPABILITY_META_NAME}"`,
    )
    document.open()
    document.write(served.body)
    document.close()
  })

  afterEach(async () => {
    await app.close()
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
      rm(distDir, { recursive: true, force: true }),
    ])
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the request reaches the handler', async () => {
    // Not a 401: the gate passed, and what came back is the handler's own
    // complaint about the lane. That is the whole claim of this test.
    await expect(requestLaunch(MALFORMED, transportOnly(app))).rejects.toThrow(/could not launch — .*lane/)
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back to the operator", async () => {
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.setAttribute('content', '0'.repeat(64))

    await expect(requestLaunch(MALFORMED, transportOnly(app))).rejects.toThrow(
      /missing or invalid x-rhizomorph-capability/,
    )
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.remove()
    const transport = vi.fn(transportOnly(app))

    await expect(requestLaunch(MALFORMED, transport)).rejects.toThrow('this page carries no capability token')
    expect(transport).not.toHaveBeenCalled()
  })
})
