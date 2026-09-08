import { beforeAll, describe, expect, it, vi } from 'vitest'
import { missingTokenMessage, staleTokenMessage } from '../recordings/capability-guidance.js'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { RETARGET_URL, type RetargetFetchLike, requestRetarget } from './retarget.js'

/**
 * The app's sixth mutating call. Two things it must never do:
 *
 * - **Believe an answer it doesn't recognise.** A switch half-believed leaves
 *   an operator reading the wrong repo's facts on every later step.
 * - **Confuse a refusal with a failure.** `already-watching`, a validation
 *   reason, a boundary already in flight, or a replay server with no code at
 *   all — every 409 is a value the wizard can show as itself, never an
 *   exception a `catch` paints red.
 */

const TEST_TOKEN = 'test-capability-token'
const TARGET = '/home/x/other'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): RetargetFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

const SWITCHED = {
  closed: { sessionId: '1000', filePath: '/data/repo-aaaa/session-1000.jsonl', eventCount: 12, closedAt: 5000, synced: true },
  opened: { sessionId: '5000', filePath: '/data/other-bbbb/session-5000.jsonl', startedAt: 5000 },
  from: { repoPath: '/home/x/repo', repoName: 'repo', repoSlug: 'repo-aaaa', sessionDir: '/data/repo-aaaa' },
  to: { repoPath: TARGET, repoName: 'other', repoSlug: 'other-bbbb', sessionDir: '/data/other-bbbb' },
  telemetry: {
    previousInstance: '1000',
    instance: '5000',
    lanes: ['lane-a', 'lane-b'],
    reissue: ['rhizomorph env lane-a --port 4317', 'rhizomorph env lane-b --port 4317'],
    reissueTemplate: 'rhizomorph env <lane> --port 4317',
    lost: ['llm.cost', 'llm.usage (OTLP)', 'trace.span', 'active time'],
    stillWorking: ['git', 'tmux', 'workmux', 'sessionlog transcripts'],
    note: '2 lanes still export as instance 1000 and are now refused whole — re-issue the env above.',
  },
}

describe('requestRetarget', () => {
  it('asks the one route, with the one verb, carrying both headers and the path body', async () => {
    const fetchImpl = vi.fn(answering(SWITCHED))

    await requestRetarget({ path: TARGET }, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(RETARGET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify({ path: TARGET }),
    })
  })

  it('reads the switch — both repos, both sessions, the telemetry cost verbatim, and nothing the route did not carry', async () => {
    const outcome = await requestRetarget({ path: TARGET }, answering(SWITCHED))

    expect(outcome).toEqual({
      kind: 'switched',
      from: { repoPath: '/home/x/repo', repoName: 'repo' },
      to: { repoPath: TARGET, repoName: 'other' },
      closed: { sessionId: '1000', synced: true, syncError: null },
      opened: { sessionId: '5000' },
      telemetry: SWITCHED.telemetry,
    })
  })

  it('carries an unsynced close’s error through, rather than reading it as synced', async () => {
    const outcome = await requestRetarget(
      { path: TARGET },
      answering({ ...SWITCHED, closed: { ...SWITCHED.closed, synced: false, syncError: 'EIO' } }),
    )

    expect(outcome.kind).toBe('switched')
    expect(outcome.kind === 'switched' && outcome.closed.syncError).toBe('EIO')
  })

  it('reads a named refusal as a value, with the server’s own sentence', async () => {
    const outcome = await requestRetarget(
      { path: TARGET },
      answering(
        {
          code: 'already-watching',
          error: 'this rhizomorph is already watching /home/x/other — there is nothing to retarget',
        },
        409,
      ),
    )

    expect(outcome).toEqual({
      kind: 'refused',
      code: 'already-watching',
      message: 'this rhizomorph is already watching /home/x/other — there is nothing to retarget',
    })
  })

  it('reads a codeless refusal — a replay server’s own — with code null and the sentence kept', async () => {
    const outcome = await requestRetarget(
      { path: TARGET },
      answering({ error: 'this server is replaying a session record, not watching a repo' }, 409),
    )

    expect(outcome).toEqual({
      kind: 'refused',
      code: null,
      message: 'this server is replaying a session record, not watching a repo',
    })
  })

  it('reads a code it does not recognise as null, rather than inventing a meaning for it', async () => {
    const outcome = await requestRetarget(
      { path: TARGET },
      answering({ code: 'something-new', error: 'a refusal this build has never heard of' }, 409),
    )

    expect(outcome).toEqual({ kind: 'refused', code: null, message: 'a refusal this build has never heard of' })
  })

  it('repeats the same refusal on repeated calls — no caching, no state', async () => {
    const fetchImpl = vi.fn(answering({ code: 'writer-alive', error: 'another rhizomorph is already watching it' }, 409))

    const outcomes = await Promise.all([
      requestRetarget({ path: TARGET }, fetchImpl),
      requestRetarget({ path: TARGET }, fetchImpl),
      requestRetarget({ path: TARGET }, fetchImpl),
    ])

    expect(outcomes).toEqual([
      { kind: 'refused', code: 'writer-alive', message: 'another rhizomorph is already watching it' },
      { kind: 'refused', code: 'writer-alive', message: 'another rhizomorph is already watching it' },
      { kind: 'refused', code: 'writer-alive', message: 'another rhizomorph is already watching it' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('a stale token is refused with the reload remedy, the server’s own sentence kept', async () => {
    await expect(
      requestRetarget(
        { path: TARGET },
        answering({ error: 'missing or invalid x-rhizomorph-capability header — reload this page' }, 401),
      ),
    ).rejects.toThrow(
      staleTokenMessage('switch the watched repo', 'missing or invalid x-rhizomorph-capability header — reload this page'),
    )
  })

  it('a body refusal (400) is thrown with the server’s own sentence, not swallowed as a value', async () => {
    await expect(
      requestRetarget({ path: TARGET }, answering({ error: '`path` is required and must be a non-empty string' }, 400)),
    ).rejects.toThrow('could not switch the watched repo — `path` is required and must be a non-empty string')
  })

  it('refuses a 200 body missing telemetry — a switch half-answered is not a switch', async () => {
    const { telemetry: _telemetry, ...withoutTelemetry } = SWITCHED
    await expect(requestRetarget({ path: TARGET }, answering(withoutTelemetry))).rejects.toThrow(
      'the instrument answered something other than a retarget result',
    )
  })

  it('refuses a 200 body whose telemetry.lanes is not an array', async () => {
    await expect(
      requestRetarget(
        { path: TARGET },
        answering({ ...SWITCHED, telemetry: { ...SWITCHED.telemetry, lanes: 'lane-a' } }),
      ),
    ).rejects.toThrow('the instrument answered something other than a retarget result')
  })

  it('refuses before the wire when this page carries no capability token', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    meta?.remove()
    const fetchImpl = vi.fn(answering(SWITCHED))

    try {
      await expect(requestRetarget({ path: TARGET }, fetchImpl)).rejects.toThrow(
        missingTokenMessage('switch the watched repo'),
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (meta !== null && meta !== undefined) document.head.appendChild(meta)
    }
  })

  it('refuses an empty path before the wire — a page bug, not a server refusal', async () => {
    const fetchImpl = vi.fn(answering(SWITCHED))

    await expect(requestRetarget({ path: '   ' }, fetchImpl)).rejects.toThrow(/empty path/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a transport failure in its own words', async () => {
    const fetchImpl: RetargetFetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(requestRetarget({ path: TARGET }, fetchImpl)).rejects.toThrow(
      'could not reach the instrument: ECONNREFUSED',
    )
  })
})
