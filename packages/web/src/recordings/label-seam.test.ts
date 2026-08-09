import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSessionLabel } from '../../../server/src/log/label.js'
import { sessionFileName } from '../../../server/src/log/paths.js'
import { buildApp } from '../../../server/src/server/build-app.js'
import { SessionRecorder } from '../../../server/src/server/recorder.js'
import { CAPABILITY_META_NAME } from './capability.js'
import { type LabelFetchLike, requestLabel } from './label.js'

/**
 * THE SEAM TEST (#249's leading acceptance criterion).
 *
 * Issue #249 shipped because both ends of the rename were tested against a
 * fake of the other: `api/label.test.ts` manufactures the capability header
 * from `app.capabilityToken` (a value the browser cannot read), and this
 * directory's own unit tests hand-build the `<meta>` tag and inject a fetch
 * double that answers whatever the test says. Every test was green while
 * every real rename 401ed.
 *
 * This file is the one place that crosses the wire for real, in both
 * directions: the REAL `buildApp` serves the REAL app shell (stamped by
 * `server/static.ts` at serve time), the REAL `readCapabilityToken` reads it
 * off the REAL document, and the REAL `requestLabel` composes the request
 * the REAL `requireCapabilityToken` judges. Nothing here writes a meta tag,
 * names the header, or reads `app.capabilityToken` — if either side renames
 * its constant, drops the stamp, or stops sending the header, this file goes
 * red the way the dashboard would.
 *
 * The only test-provided piece is transport: `LabelFetchLike` carried over
 * Fastify's `inject` instead of a TCP socket, forwarding verbatim whatever
 * the client composed. That is a wire, not a double — it decides nothing.
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

/** Pure transport: forwards exactly what the client composed to the real app, and answers exactly what the app said. */
function transportOnly(app: FastifyInstance): LabelFetchLike {
  return async (url, init) => {
    const response = await app.inject({ method: init.method, url, headers: init.headers, payload: init.body })
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      json: async () => response.json() as unknown,
    }
  }
}

describe('the rename seam: served page → real client → real gate (#249)', () => {
  let repoPath: string
  let sessionDir: string
  let distDir: string
  let app: FastifyInstance

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-seam-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-seam-dir-'))
    distDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-seam-dist-'))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(path.join(distDir, 'index.html'), APP_SHELL, 'utf8')

    const f = createEventFactory({ startTs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath, repoName: 'repo' })
    await writeFile(path.join(sessionDir, sessionFileName(1000)), eventsToJsonl(f.all()), 'utf8')

    const recorder = new SessionRecorder('2000', path.join(sessionDir, sessionFileName(2000)))
    app = buildApp({ repoPath, repoName: 'repo', sessionDir, recorder, now: () => 9999, webDistDir: distDir })

    // The page the operator's browser would be looking at: what GET / really
    // served on this boot, loaded wholesale — not a hand-made meta tag.
    const served = await app.inject({ method: 'GET', url: '/' })
    expect(served.statusCode).toBe(200)
    document.open()
    document.write(served.body)
    document.close()
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
      rm(distDir, { recursive: true, force: true }),
    ])
  })

  it('rename-in-place succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const outcome = await requestLabel('1000', 'the morning run', transportOnly(app))

    expect(outcome).toEqual({ sessionId: '1000', label: 'the morning run' })
    // The rename really landed server-side: sidecar written, listing updated.
    expect(await readSessionLabel(sessionDir, '1000')).toBe('the morning run')
    const listing = (await app.inject({ method: 'GET', url: '/api/sessions' })).json() as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listing.sessions[0]).toMatchObject({ id: '1000', label: 'the morning run' })
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back to the operator", async () => {
    // Same shape the server would accept (64 hex), wrong value — so this
    // exercises the gate's comparison, not the stamp's shape check.
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.setAttribute('content', '0'.repeat(64))

    await expect(requestLabel('1000', 'renamed', transportOnly(app))).rejects.toThrow(/capability token/)
    expect(await readSessionLabel(sessionDir, '1000')).toBeNull()
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.remove()
    const transport = vi.fn(transportOnly(app))

    await expect(requestLabel('1000', 'renamed', transport)).rejects.toThrow(
      'no capability token found on this page — cannot save the label',
    )
    expect(transport).not.toHaveBeenCalled()
  })
})
