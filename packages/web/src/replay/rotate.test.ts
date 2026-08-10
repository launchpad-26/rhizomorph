import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// Deliberate, test-only cross-package edge, exactly as `recordings/
// label-seam.test.ts` documents it: the seam the last block of this file
// exists to prove is web↔server, so the server's REAL modules come in by
// path. The mutating-calls law's sweep excludes test files; no non-test file
// under packages/web/src may import server source.
import { sessionFileName } from '../../../server/src/log/paths.js'
import { readSessionEvents } from '../../../server/src/log/session-log.js'
import { buildApp } from '../../../server/src/server/build-app.js'
import { SessionRecorder } from '../../../server/src/server/recorder.js'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { requestRotation, ROTATE_URL, type RotateFetchLike } from './rotate.js'

/**
 * The app's first mutating call. What it must never do is believe an answer it
 * doesn't recognise: a rotation the operator was told happened, but didn't,
 * would send them looking in the picker for a recording that isn't there.
 *
 * Since #234 it must also carry the per-process capability token, because the
 * route now requires it — the reason that widening is here, in the same commit
 * as the gate, is #249: `/api/label` was gated with no way for its caller to
 * authenticate and 401ed on every boot for weeks, looking like a UI bug. The
 * last block of this file is the seam test that makes the same mistake
 * impossible on this route: real served page, real client, real gate.
 */

const ROTATION = {
  closed: { sessionId: '1000', filePath: '/data/repo/session-1000.jsonl', eventCount: 1234 },
  opened: { sessionId: '5000', filePath: '/data/repo/session-5000.jsonl', startedAt: 5000 },
}

const TEST_TOKEN = 'test-capability-token'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249, ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): RotateFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

describe('requestRotation', () => {
  it('asks the one route, with the one verb, carrying the capability token, and returns both sides of the boundary', async () => {
    const fetchImpl = vi.fn(answering(ROTATION))

    const rotation = await requestRotation(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(ROTATE_URL, {
      method: 'POST',
      headers: { 'x-rhizomorph-capability': TEST_TOKEN },
    })
    expect(rotation).toEqual({
      closed: { sessionId: '1000', eventCount: 1234 },
      opened: { sessionId: '5000' },
    })
  })

  /**
   * ADR-0012's known dev-mode gap, made honest rather than closed (closing it
   * needs a vite plugin and proxy config, which is out of #234's scope). Under
   * `npm run dev:web` vite serves `index.html` itself, so the server's
   * injection never runs and this page has no token. The operator must read
   * what is missing and what to run — a bare 401 about a header they cannot
   * supply is the failure mode that hid #249 for weeks.
   */
  it('refuses before the wire when the page carries no token, naming what is missing and what to run', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    const content = meta?.getAttribute('content') ?? null
    meta?.remove()
    const fetchImpl = vi.fn(answering(ROTATION))

    try {
      const failure = await requestRotation(fetchImpl).catch((err: unknown) => err)

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('this page carries no capability token')
      expect(message).toContain('dev:web')
      expect(message).toContain('npm run build')
      // Nothing was sent — a request that cannot be authorised is not made.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      const restored = document.createElement('meta')
      restored.setAttribute('name', CAPABILITY_META_NAME)
      restored.setAttribute('content', content ?? TEST_TOKEN)
      document.head.appendChild(restored)
    }
  })

  it("surfaces the instrument's own refusal, so the button can show it", async () => {
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)

    await expect(requestRotation(fetchImpl)).rejects.toThrow(
      'could not end the session — this server is replaying a session record',
    )
  })

  it('falls back to the status when a refusal carries no message', async () => {
    await expect(requestRotation(answering(null, 500))).rejects.toThrow('the server answered 500')
  })

  it('says the instrument is unreachable rather than swallowing a network failure', async () => {
    const fetchImpl: RotateFetchLike = async () => {
      throw new Error('NetworkError')
    }

    await expect(requestRotation(fetchImpl)).rejects.toThrow('could not reach the instrument: NetworkError')
  })

  it('refuses to report a rotation from an answer that is not one', async () => {
    for (const payload of [{}, { closed: { sessionId: '1000' } }, { closed: {}, opened: {} }, 'ok']) {
      await expect(requestRotation(answering(payload))).rejects.toThrow(
        'the instrument answered something other than a rotation',
      )
    }
  })
})

/**
 * THE ROTATION SEAM (#234, in the shape #249's own acceptance criterion took).
 *
 * Every test above this line is green whether or not the two halves agree:
 * the meta tag is hand-built and the transport is a double that answers
 * whatever the test says. That is exactly the arrangement under which #249
 * shipped — both ends tested against a fake of the other, every test green,
 * every real rename 401ing.
 *
 * This block crosses the wire for real in both directions: the REAL `buildApp`
 * serves the REAL app shell (stamped by `server/static.ts` at serve time), the
 * REAL `readCapabilityToken` reads it off the REAL document, and the REAL
 * `requestRotation` composes the request the REAL `requireCapabilityToken`
 * judges. Nothing here writes a meta tag, names the header, or reads
 * `app.capabilityToken` — if either side renames its constant, drops the
 * stamp, or stops sending the header, this goes red the way the dashboard
 * would.
 *
 * The only test-provided piece is transport: `RotateFetchLike` carried over
 * Fastify's `inject` instead of a TCP socket, forwarding verbatim whatever the
 * client composed. That is a wire, not a double — it decides nothing.
 */
describe('the rotation seam: served page → real client → real gate (#234)', () => {
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
  function transportOnly(app: FastifyInstance): RotateFetchLike {
    return async (url, init) => {
      const response = await app.inject({ method: init.method, url, headers: init.headers })
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => response.json() as unknown,
      }
    }
  }

  let repoPath: string
  let sessionDir: string
  let distDir: string
  let app: FastifyInstance

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-seam-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-seam-dir-'))
    distDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rotate-seam-dist-'))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(path.join(distDir, 'index.html'), APP_SHELL, 'utf8')

    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('1000', path.join(sessionDir, sessionFileName(1000)))
    app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 9999, webDistDir: distDir })

    // The page the operator's browser would be looking at: what GET / really
    // served on this boot, loaded wholesale — not a hand-made meta tag. The
    // stamp must actually be there before the refusal tests below can mean
    // anything, or they would pass vacuously on the client's own throw.
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

  it('rotation succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const rotation = await requestRotation(transportOnly(app))

    expect(rotation.closed.sessionId).toBe('1000')
    expect(rotation.opened.sessionId).toBe('9999')
    // The boundary really landed server-side, not just in the answer.
    const closed = await readSessionEvents(path.join(sessionDir, sessionFileName(1000)))
    expect(closed.at(-1)?.type).toBe('session.closed')
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back to the operator", async () => {
    // Same shape the server would accept (64 hex), wrong value — so this
    // exercises the gate's comparison, not the stamp's shape check.
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.setAttribute('content', '0'.repeat(64))

    // The server's phrase, not the client's — the client has its own refusal
    // for a missing token, and this test's whole claim is that the SERVER's
    // sentence crossed back.
    await expect(requestRotation(transportOnly(app))).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)

    const untouched = await readSessionEvents(path.join(sessionDir, sessionFileName(1000)))
    expect(untouched.map((event) => event.type)).toEqual(['session.started'])
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.remove()
    const transport = vi.fn(transportOnly(app))

    await expect(requestRotation(transport)).rejects.toThrow('this page carries no capability token')
    expect(transport).not.toHaveBeenCalled()
  })
})
