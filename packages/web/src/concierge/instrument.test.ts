import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { INSTRUMENT_URL, type InstrumentFetchLike, requestInstrument } from './instrument.js'

/**
 * The app's fourth mutating call. Two things it must never do, both of which
 * cost the operator a real process:
 *
 * - **Believe an answer it doesn't recognise.** An operator told their
 *   conversation resumed, when it did not, goes looking for a process nothing
 *   started — and, worse here than for rotation, may end the origin process on
 *   the strength of it.
 * - **Confuse "nothing to resume from" with "the request failed".** A 404 is
 *   the ordinary case for a conversation that happened somewhere this
 *   instrument was never told about; it comes back as a VALUE the UI can point
 *   at a command with, not an exception a `catch` paints red.
 */

const SESSION_ID = 'sess-4210'
const TEST_TOKEN = 'test-capability-token'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249, ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): InstrumentFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

const LAUNCHED = { harness: 'claude', mode: 'resume', migration: 'migrated', kind: 'launched', pid: 4242 }

describe('requestInstrument', () => {
  it('asks the one route, with the one verb, carrying both headers and the resume body', async () => {
    const fetchImpl = vi.fn(answering(LAUNCHED))

    await requestInstrument({ sessionId: SESSION_ID }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(INSTRUMENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify({ harness: 'claude', mode: 'resume', sessionId: SESSION_ID }),
    })
  })

  it('returns the migration fact and the pid, under the SAME session id the caller asked for', async () => {
    const outcome = await requestInstrument({ sessionId: SESSION_ID }, answering(LAUNCHED))

    expect(outcome).toEqual({
      kind: 'instrumented',
      sessionId: SESSION_ID,
      migration: 'migrated',
      spawn: { launched: true, pid: 4242 },
    })
  })

  it.each(['migrated', 'already-present', 'not-needed'] as const)(
    'carries the migration fact through verbatim: %s',
    async (migration) => {
      const outcome = await requestInstrument(
        { sessionId: SESSION_ID },
        answering({ ...LAUNCHED, migration }),
      )

      expect(outcome).toEqual({
        kind: 'instrumented',
        sessionId: SESSION_ID,
        migration,
        spawn: { launched: true, pid: 4242 },
      })
    },
  )

  /**
   * The spawn failing is not the REQUEST failing — `api/concierge.ts` puts it
   * in the 200 body deliberately, because by then the migration copy may
   * already have run and that is a fact the operator has to be told.
   */
  it('reports a spawn that failed as an outcome, not a throw — the copy may already have happened', async () => {
    const outcome = await requestInstrument(
      { sessionId: SESSION_ID },
      answering({ ...LAUNCHED, migration: 'already-present', kind: 'error', pid: undefined, message: 'ENOENT claude' }),
    )

    expect(outcome).toEqual({
      kind: 'instrumented',
      sessionId: SESSION_ID,
      migration: 'already-present',
      spawn: { launched: false, message: 'ENOENT claude' },
    })
  })

  /**
   * The one refusal that is a value. Nothing was spawned and nothing was
   * copied, so there is nothing to warn about — only a next step to hand over,
   * which is why the instrument's own sentence rides along.
   */
  it('turns a 404 into a no-transcript-reachable outcome, carrying the instrument’s own reason', async () => {
    const outcome = await requestInstrument(
      { sessionId: SESSION_ID },
      answering({ error: 'no transcript for sess-4210 under any projects root this instrument knows' }, 404),
    )

    expect(outcome).toEqual({
      kind: 'no-transcript-reachable',
      reason: 'no transcript for sess-4210 under any projects root this instrument knows',
    })
  })

  it('falls back to the status when a 404 carries no sentence of its own', async () => {
    const outcome = await requestInstrument({ sessionId: SESSION_ID }, answering(null, 404))

    expect(outcome).toEqual({ kind: 'no-transcript-reachable', reason: 'the server answered 404' })
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
    const fetchImpl = vi.fn(answering(LAUNCHED))

    try {
      const failure = await requestInstrument({ sessionId: SESSION_ID }, fetchImpl).catch((err: unknown) => err)

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('could not instrument this session')
      expect(message).toContain('this page carries no capability token')
      expect(message).toContain('dev:web')
      expect(message).toContain('npm run build')
      // Nothing was sent — a request that cannot be authorised is not made,
      // and no process was spawned on the strength of a header it never had.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      const restored = document.createElement('meta')
      restored.setAttribute('name', CAPABILITY_META_NAME)
      restored.setAttribute('content', content ?? TEST_TOKEN)
      document.head.appendChild(restored)
    }
  })

  it('says what to DO about a 401, keeping the instrument’s own sentence first', async () => {
    const failure = await requestInstrument(
      { sessionId: SESSION_ID },
      answering({ error: 'missing or invalid x-rhizomorph-capability header' }, 401),
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('missing or invalid x-rhizomorph-capability header')
    expect(message).toContain('Reload this page')
  })

  it('reports a network failure as one — the instrument was never reached, so nothing was started', async () => {
    const failure = await requestInstrument({ sessionId: SESSION_ID }, async () => {
      throw new Error('connection refused')
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('could not reach the instrument: connection refused')
  })

  it('reports any other refusal in one plain sentence, with the server’s own account in it', async () => {
    const failure = await requestInstrument(
      { sessionId: SESSION_ID },
      answering({ error: 'this server is replaying a session record, not watching a repo' }, 409),
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'could not instrument this session — this server is replaying a session record, not watching a repo',
    )
  })

  it.each([
    ['a body that is not an object', 'a relaunch, surely'],
    ['no migration fact at all', { kind: 'launched', pid: 1 }],
    ['a migration fact this module does not know', { migration: 'moved', kind: 'launched', pid: 1 }],
    ['a spawn result it cannot read', { migration: 'migrated', kind: 'started', pid: 1 }],
    ['a launched spawn with no pid', { migration: 'migrated', kind: 'launched' }],
    ['a failed spawn with no message', { migration: 'migrated', kind: 'error' }],
  ])('refuses to believe %s', async (_label, payload) => {
    const failure = await requestInstrument({ sessionId: SESSION_ID }, answering(payload)).catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('the instrument answered something other than a relaunch result')
  })

  it('refuses a 200 whose body is not JSON at all', async () => {
    const failure = await requestInstrument({ sessionId: SESSION_ID }, async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected end of JSON input')
      },
    })).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('the instrument answered something other than a relaunch result')
  })
})
