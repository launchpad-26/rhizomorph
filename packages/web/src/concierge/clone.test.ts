import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { CLONE_URL, readCloneStream, requestClone, type CloneFetchLike } from './clone.js'

/**
 * The app's fifth mutating call. Three things it must never do, each of which
 * costs the operator something real:
 *
 * - **Send without a token.** The route writes to disk; a request that cannot
 *   be authorised is not made at all, so an operator on a page served the wrong
 *   way reads what is missing rather than a 401 about a header they cannot
 *   supply.
 * - **Report a clone that did not happen.** The stream says whether `git`
 *   finished. A body that never says so is refused outright — an operator told
 *   a repository arrived, when it did not, goes looking for a directory nothing
 *   created.
 * - **Throw away `git`'s account of a failure.** The progress lines ARE the
 *   evidence for a failed clone, so they ride on the outcome rather than being
 *   read for a status and discarded.
 */

const TEST_TOKEN = 'test-capability-token'
const URL = 'https://example.invalid/owner/repo.git'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249, ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

/** A 200 carrying an NDJSON body — the shape the route really streams. */
function streaming(lines: readonly unknown[]): CloneFetchLike {
  const body = lines.map((line) => JSON.stringify(line)).join('\n')
  return async () => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  })
}

/** A refusal decided before the stream opened — one ordinary JSON document. */
function refusing(status: number, payload: unknown): CloneFetchLike {
  return async () => ({
    ok: false,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })
}

const DONE = { type: 'done', path: '/home/x/.rhizomorph/clones/repo' }

describe('requestClone', () => {
  it('asks the one route, with the one verb, carrying both headers and only the URL', async () => {
    const fetchImpl = vi.fn(streaming([DONE]))

    await requestClone({ url: URL }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(CLONE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify({ url: URL }),
    })
  })

  it('answers with the path the SERVER chose, never one this client composed', async () => {
    const outcome = await requestClone({ url: URL }, streaming([DONE]))

    expect(outcome).toEqual({ kind: 'cloned', path: '/home/x/.rhizomorph/clones/repo', progress: [] })
  })

  it("carries git's own progress lines, in order, on a clone that worked", async () => {
    const outcome = await requestClone(
      { url: URL },
      streaming([
        { type: 'progress', line: 'Cloning into repo...' },
        { type: 'progress', line: 'Receiving objects: 100%' },
        DONE,
      ]),
    )

    expect(outcome).toEqual({
      kind: 'cloned',
      path: '/home/x/.rhizomorph/clones/repo',
      progress: ['Cloning into repo...', 'Receiving objects: 100%'],
    })
  })

  /**
   * A clone that ran and failed is not the REQUEST failing — the route puts it
   * in the streamed body deliberately, because by then a destination directory
   * may exist on the operator's disk and that is a fact they have to be told.
   */
  it('reports a clone that git refused as an outcome, not a throw — and keeps the evidence', async () => {
    const outcome = await requestClone(
      { url: URL },
      streaming([
        { type: 'progress', line: 'Cloning into repo...' },
        { type: 'error', message: 'git exited with code 128' },
      ]),
    )

    expect(outcome).toEqual({
      kind: 'clone-failed',
      message: 'git exited with code 128',
      progress: ['Cloning into repo...'],
    })
  })

  it('refuses a stream that never says whether the repository arrived — a half-believed clone is the one answer this must not give', async () => {
    const failure = await requestClone({ url: URL }, streaming([{ type: 'progress', line: 'Cloning…' }])).catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/ended without saying whether the repository arrived/)
  })

  it('reports a 400 as a refusal in one plain sentence, with the server’s own account in it', async () => {
    const failure = await requestClone(
      { url: 'nonsense' },
      refusing(400, { error: '"url" must be an http(s)/ssh/git URL' }),
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('could not clone that repository — "url" must be an http(s)/ssh/git URL')
  })

  it('says what to DO about a 401, keeping the instrument’s own sentence first', async () => {
    const failure = await requestClone(
      { url: URL },
      refusing(401, { error: 'missing or invalid x-rhizomorph-capability header' }),
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('missing or invalid x-rhizomorph-capability header')
    expect(message).toContain('Reload this page')
  })

  it('falls back to the status when a refusal carries no sentence of its own', async () => {
    const failure = await requestClone({ url: URL }, refusing(409, null)).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('could not clone that repository — the server answered 409')
  })

  it('reports a network failure as one — the instrument was never reached, so nothing was cloned', async () => {
    const failure = await requestClone({ url: URL }, async () => {
      throw new Error('connection refused')
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('could not reach the instrument: connection refused')
  })

  it('reports a connection lost mid-clone as itself, never as a clone that failed', async () => {
    const failure = await requestClone({ url: URL }, async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => {
        throw new Error('terminated')
      },
    })).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('the clone started, and this page lost the connection while it ran: terminated')
  })

  /**
   * ADR-0012's known dev-mode gap, made honest rather than closed: under `npm
   * run dev:web` vite serves `index.html` itself, so the server's injection
   * never runs and this page has no token. A bare 401 about a header the
   * operator cannot supply is the failure mode that hid #249 for weeks.
   */
  it('refuses before the wire when the page carries no token, naming what is missing and what to run', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    const content = meta?.getAttribute('content') ?? null
    meta?.remove()
    const fetchImpl = vi.fn(streaming([DONE]))

    try {
      const failure = await requestClone({ url: URL }, fetchImpl).catch((err: unknown) => err)

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('could not clone a repository')
      expect(message).toContain('this page carries no capability token')
      expect(message).toContain('dev:web')
      expect(message).toContain('npm run build')
      // Nothing was sent — a request that cannot be authorised is not made, and
      // nothing was written to disk on the strength of a header it never had.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      const restored = document.createElement('meta')
      restored.setAttribute('name', CAPABILITY_META_NAME)
      restored.setAttribute('content', content ?? TEST_TOKEN)
      document.head.appendChild(restored)
    }
  })
})

describe('readCloneStream', () => {
  const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n')

  it('skips a line it cannot parse rather than losing the whole answer — a truncated last write is the ordinary case', () => {
    const body = `${lines({ type: 'progress', line: 'a' })}\n{"type":"prog\n${lines(DONE)}`

    expect(readCloneStream(body)).toEqual({ kind: 'cloned', path: DONE.path, progress: ['a'] })
  })

  it('skips an event type this build has never heard of, and still reads the ones it knows', () => {
    const body = lines({ type: 'warning', message: 'from a newer server' }, { type: 'progress', line: 'a' }, DONE)

    expect(readCloneStream(body)).toEqual({ kind: 'cloned', path: DONE.path, progress: ['a'] })
  })

  it('keeps the FIRST terminal event — a second answer means this client misread the first, not that the first was wrong', () => {
    const body = lines(DONE, { type: 'error', message: 'and then this' })

    expect(readCloneStream(body)).toMatchObject({ kind: 'cloned' })
  })

  it('carries a line that arrived after the terminal event — nothing git said is dropped for having been said late', () => {
    const body = lines({ type: 'progress', line: 'before' }, DONE, { type: 'progress', line: 'after' })

    expect(readCloneStream(body)).toEqual({ kind: 'cloned', path: DONE.path, progress: ['before', 'after'] })
  })

  it.each([
    ['a done with no path', { type: 'done' }],
    ['a done with an empty path', { type: 'done', path: '' }],
    ['an error with no message', { type: 'error' }],
    ['an error with an empty message', { type: 'error', message: '' }],
  ])('refuses to read %s as terminal — a terminal event that says nothing terminates nothing', (_label, event) => {
    expect(readCloneStream(lines(event))).toBeNull()
  })

  it('reads an empty body as no answer at all', () => {
    expect(readCloneStream('')).toBeNull()
  })
})
