import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Fetch } from '../auth/github-app.js'
import { SESSION_COOKIE, SESSION_TTL_MS, signSessionCookie, deriveSessionKey } from '../auth/session.js'
import { resolveTeamConfig } from '../config/config.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { REFUSAL_TEXT, type ViewRefusal, handleQuestion, statusForViewRefusal } from './questions.js'

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CLIENT_SECRET = 'test-client-secret'
const ENV = {
  RZ_TEAM_GITHUB_ORG: 'rhizomorph-team',
  RZ_TEAM_GITHUB_APP_ID: '123456',
  RZ_TEAM_GITHUB_INSTALLATION_ID: '789',
  RZ_TEAM_GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
  RZ_TEAM_GITHUB_CLIENT_ID: 'Iv1.test',
  RZ_TEAM_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
}

const NOW = Date.UTC(2026, 8, 16, 12)

/** The membership GET answers `memberStatus`; the token mint always succeeds. */
function fakeFetch(memberStatus: number): Fetch {
  return (async (url: string | URL) => {
    const target = String(url)
    if (target.endsWith('/access_tokens')) {
      return { status: 201, json: async () => ({ token: 'ghs_install_tok' }) } as unknown as Response
    }
    return { status: memberStatus, json: async () => ({}) } as unknown as Response
  }) as unknown as Fetch
}

/** The token mint itself fails — `checkOrgMembership` returns `error`, never `not-a-member`. */
function mintFailsFetch(): Fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/access_tokens')) {
      return { status: 500, json: async () => ({ message: 'boom' }) } as unknown as Response
    }
    return { status: 204, json: async () => ({}) } as unknown as Response
  }) as unknown as Fetch
}

function deps(memberStatus = 204, storage = new FakeTeamStorage()) {
  return {
    storage,
    config: resolveTeamConfig({ ...ENV }),
    fetch: fakeFetch(memberStatus),
    now: () => NOW,
  }
}

function cookieFor(login: string, issuedAtMs = NOW): string {
  const value = signSessionCookie(deriveSessionKey(CLIENT_SECRET), { uid: 42, sub: login }, issuedAtMs)
  return `${SESSION_COOKIE}=${value}`
}

const PROJECT = 'acme-widgets'

describe('#557 — the member gate on the three questions', () => {
  it('a member sees the rows', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: 'prd51-w11', state: 'building', worktree: '/repo-wt/w11', lastEventTsMs: NOW })
    const view = await handleQuestion(deps(204, storage), 'where', { cookieHeader: cookieFor('ada'), project: PROJECT })
    expect(view.status).toBe(200)
    expect(view.html).toContain('prd51-w11')
    expect(view.headers['content-type']).toContain('text/html')
  })

  /**
   * #169's case, and the one a reasonable implementation gets wrong.
   *
   * `auth/membership.ts` documents a 404 from the membership GET as `no-such-membership`,
   * "also what a pending, never-accepted invite looks like". An invitation that was sent and
   * never accepted is NOT membership, and this is where that is decided.
   */
  it('A PENDING INVITEE IS NOT A MEMBER — a 404 from the membership GET is a refusal', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: 'secret-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    const view = await handleQuestion(deps(404, storage), 'where', { cookieHeader: cookieFor('mallory'), project: PROJECT })
    expect(view.status).toBe(403)
    // The refusal leaks NOTHING of the answer it withheld.
    expect(view.html).not.toContain('secret-lane')
  })

  it('no cookie at all is 401, and says where to sign in', async () => {
    const view = await handleQuestion(deps(), 'cost', { cookieHeader: undefined, project: PROJECT })
    expect(view.status).toBe(401)
    expect(view.html).toContain('/auth/github/start')
  })

  it('a TAMPERED cookie is 401, and the reason goes to the operator rather than the wire', async () => {
    const view = await handleQuestion(deps(), 'cost', { cookieHeader: `${SESSION_COOKIE}=not-a-real-token`, project: PROJECT })
    expect(view.status).toBe(401)
    expect(view.operatorNote).toContain('session rejected')
    expect(view.html).not.toContain('signature')
  })

  it('an EXPIRED session is 401 — a cookie past its TTL is not a member', async () => {
    const stale = cookieFor('ada', NOW - SESSION_TTL_MS - 1)
    const view = await handleQuestion(deps(), 'stuck', { cookieHeader: stale, project: PROJECT })
    expect(view.status).toBe(401)
    expect(view.operatorNote).toContain('expired')
  })

  it('an unconfigured deployment says so (503) rather than calling the caller a non-member', async () => {
    const bare = { storage: new FakeTeamStorage(), config: resolveTeamConfig({}), fetch: fakeFetch(204), now: () => NOW }
    const view = await handleQuestion(bare, 'where', { cookieHeader: undefined, project: PROJECT })
    expect(view.status).toBe(503)
  })

  it('a missing ?project is 400 — named, not guessed', async () => {
    const view = await handleQuestion(deps(), 'where', { cookieHeader: cookieFor('ada'), project: undefined })
    expect(view.status).toBe(400)
  })

  it('every refusal maps to its own status — no two collapse into one', () => {
    /**
     * DERIVED FROM `REFUSAL_TEXT`'S KEYS, not from a type-level assertion.
     *
     * The first version of this used `satisfies readonly ViewRefusal[]` plus an
     * `Exclude`-and-empty-array trick and claimed "drop a member below and `tsc` fails". **The
     * first half was false.** An empty array is assignable to `Missing[]` whatever `Missing` is,
     * and `satisfies` checks that each element IS a refusal, never that all of them are present —
     * so dropping `'wrong-project'`, the exact member the review before it found missing, left
     * `tsc` at exit 0 and this file at 19 passed.
     *
     * `REFUSAL_TEXT` is a `Readonly<Record<ViewRefusal, string>>`, so the COMPILER already forces
     * its keys to be the whole union and nothing here has to restate that. Comparing against
     * those keys is a runtime assertion that can actually fail, which the type-level one could
     * not. Found in the review of #574 — a guard standing exactly where the previous round's
     * defect was.
     */
    const ALL = [
      'no-session',
      'not-a-member',
      'unconfigured',
      'membership-error',
      'no-project',
      'wrong-project',
      'storage-error',
    ] as const satisfies readonly ViewRefusal[]

    // The assertion that bites: every refusal `REFUSAL_TEXT` must carry is listed, and nothing
    // else is. Drop one from `ALL` and this reddens.
    expect([...ALL].sort()).toEqual(Object.keys(REFUSAL_TEXT).sort())

    /**
     * STATUSES MAY COLLIDE; MESSAGES MAY NOT.
     *
     * This asserted distinct statuses until F1 added `storage-error`, which is 503 — the same as
     * `unconfigured`, and correctly so: `serveIngest` answers 503 for a storage read it cannot
     * complete, and mirroring it was the point. Both really are "this server cannot answer right
     * now". Picking a different status to keep a uniqueness assertion green would be choosing the
     * wire's meaning to satisfy a test.
     *
     * What must stay true is that a caller can TELL THEM APART, which is the message, and that
     * none of them is a success.
     */
    const messages = ALL.map((reason) => REFUSAL_TEXT[reason])
    expect(new Set(messages).size, 'two refusals say the same thing').toBe(messages.length)
    for (const reason of ALL) {
      expect(statusForViewRefusal(reason), reason).toBeGreaterThanOrEqual(400)
    }
    // …and the one deliberate sharing is named, so a third arrival is a decision, not a drift.
    expect(statusForViewRefusal('unconfigured')).toBe(503)
    expect(statusForViewRefusal('storage-error')).toBe(503)
  })

  /**
   * F1 (review of #574): a rejecting storage read used to propagate out of `handleQuestion`,
   * through `writeView`, into an async request listener with no handler — which node 22
   * terminates the process on. One database blip on a page any org member can reach took the
   * ingest plane down with the read plane.
   */
  it('a REJECTING storage read is a 503 refusal, not a thrown promise', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: 'secret-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    const exploding = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== 'readLaneState') return Reflect.get(target, prop, receiver)
        return async () => {
          throw new Error('connection terminated unexpectedly')
        }
      },
    }) as FakeTeamStorage

    const view = await handleQuestion(deps(204, exploding), 'where', {
      cookieHeader: cookieFor('ada'),
      project: PROJECT,
    })
    expect(view.status).toBe(503)
    // The row is withheld, and the database's own sentence reaches the operator, not the wire.
    expect(view.html).not.toContain('secret-lane')
    expect(view.html).not.toContain('connection terminated')
    expect(view.operatorNote).toContain('connection terminated unexpectedly')
  })

  it('…and the same holds for the other two questions, which is the sibling that was missed', async () => {
    for (const [question, method] of [
      ['cost', 'readSpendByDay'],
      ['stuck', 'readCollisions'],
    ] as const) {
      const storage = new FakeTeamStorage()
      const exploding = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop !== method) return Reflect.get(target, prop, receiver)
          return async () => {
            throw new Error('boom')
          }
        },
      }) as FakeTeamStorage
      const view = await handleQuestion(deps(204, exploding), question, {
        cookieHeader: cookieFor('ada'),
        project: PROJECT,
      })
      expect(view.status, question).toBe(503)
    }
  })

  it('ANOTHER PROJECT IS NOT THIS ONE — the read is scoped, and the fake reproduces the narrowing', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: 'someone-else', lane: 'their-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    const view = await handleQuestion(deps(204, storage), 'where', { cookieHeader: cookieFor('ada'), project: PROJECT })
    expect(view.status).toBe(200)
    expect(view.html).not.toContain('their-lane')
  })

  it('caller data is ESCAPED — a lane name cannot carry markup into the page', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: '<script>alert(1)</script>', state: 'building', worktree: null, lastEventTsMs: null })
    const view = await handleQuestion(deps(204, storage), 'where', { cookieHeader: cookieFor('ada'), project: PROJECT })
    expect(view.html).not.toContain('<script>alert(1)</script>')
    expect(view.html).toContain('&lt;script&gt;')
  })

  it('REPETITION — the same request twice gives byte-identical pages', async () => {
    const storage = new FakeTeamStorage()
    storage.spendRows.push({ projectId: PROJECT, day: '2026-09-16', costUsd: '12.500000', events: 3 })
    const d = deps(204, storage)
    const first = await handleQuestion(d, 'cost', { cookieHeader: cookieFor('ada'), project: PROJECT })
    const second = await handleQuestion(d, 'cost', { cookieHeader: cookieFor('ada'), project: PROJECT })
    expect(first.html).toBe(second.html)
    // …and the exact decimal reached the page unrounded.
    expect(first.html).toContain('12.500000')
  })

  it('an empty projection renders a page that says so, not a broken table', async () => {
    const view = await handleQuestion(deps(), 'stuck', { cookieHeader: cookieFor('ada'), project: PROJECT })
    expect(view.status).toBe(200)
    expect(view.html).toContain('No collisions have been seen.')
    expect(view.html).not.toContain('<table>')
  })

  /**
   * THE TWO FAIL-OPEN BRANCHES (#557, found at verification).
   *
   * Deleting either the `error` or the `unconfigured` line from `handleQuestion` used to leave
   * this file 12/12 green. Both are genuine fail-opens: execution falls through to the read, so
   * a 502-or-503 that withholds rows becomes a **200 containing them**. The lookup-table case
   * above never calls `handleQuestion`, so it could not see either.
   *
   * Both cases seed a row and assert it is ABSENT from the body, which is what makes them
   * mutation-proof: a status assertion alone would still pass if the branch returned the wrong
   * refusal, and the point is the rows, not the number.
   */
  it('a FAILED CREDENTIAL MINT is 502 and withholds the rows — never a 200 carrying them', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: 'secret-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    const view = await handleQuestion(
      { storage, config: resolveTeamConfig({ ...ENV }), fetch: mintFailsFetch(), now: () => NOW },
      'where',
      { cookieHeader: cookieFor('ada'), project: PROJECT },
    )
    expect(view.status).toBe(502)
    expect(view.html).not.toContain('secret-lane')
    expect(view.operatorNote).toBeDefined()
  })

  it('a CONFIGURED session with NO app credentials is 503 and withholds the rows', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: 'secret-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    // The client secret is present — so the session verifies and execution REACHES the
    // membership check — while the App credentials are absent, which is `unconfigured`.
    const partial = { RZ_TEAM_GITHUB_CLIENT_ID: 'Iv1.test', RZ_TEAM_GITHUB_CLIENT_SECRET: CLIENT_SECRET }
    const view = await handleQuestion(
      { storage, config: resolveTeamConfig(partial), fetch: fakeFetch(204), now: () => NOW },
      'where',
      { cookieHeader: cookieFor('ada'), project: PROJECT },
    )
    expect(view.status).toBe(503)
    expect(view.html).not.toContain('secret-lane')
  })

  /**
   * F1: the project is a SCOPE the caller names, not an authorisation boundary — except that a
   * deployment holding one project refuses any other name. Verification measured the unnarrowed
   * version returning another project's rows on a real engine.
   */
  it('a deployment that holds one project refuses a request naming another', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: 'other', lane: 'other-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    const view = await handleQuestion({ ...deps(204, storage), deploymentProject: PROJECT }, 'where', {
      cookieHeader: cookieFor('ada'),
      project: 'other',
    })
    expect(view.status).toBe(404)
    expect(view.html).not.toContain('other-lane')
  })

  it('…and still serves its own project', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: PROJECT, lane: 'mine', state: 'building', worktree: null, lastEventTsMs: NOW })
    const view = await handleQuestion({ ...deps(204, storage), deploymentProject: PROJECT }, 'where', {
      cookieHeader: cookieFor('ada'),
      project: PROJECT,
    })
    expect(view.status).toBe(200)
    expect(view.html).toContain('mine')
  })

  it('with no deployment project configured, any member may name any project — stated, not implied', async () => {
    const storage = new FakeTeamStorage()
    storage.laneRows.push({ projectId: 'other', lane: 'other-lane', state: 'building', worktree: null, lastEventTsMs: NOW })
    const view = await handleQuestion({ ...deps(204, storage), deploymentProject: '' }, 'where', {
      cookieHeader: cookieFor('ada'),
      project: 'other',
    })
    // This is the residual F1 names: org membership is the boundary, and it is org-wide.
    expect(view.status).toBe(200)
    expect(view.html).toContain('other-lane')
  })
})
