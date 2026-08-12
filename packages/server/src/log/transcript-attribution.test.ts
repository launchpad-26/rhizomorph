import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONDUCTOR_LANE,
  allAttributedLanes,
  candidateTranscriptPaths,
  capturedTranscriptPath,
  findConductorAttribution,
  findLaneAttribution,
  isPathContained,
} from './transcript-attribution.js'

const LANE = '84-chat-drawer'
const WORKTREE = '/tmp/rhizomorph-fixture/84-chat-drawer'
const PROJECT_SLUG = '-tmp-rhizomorph-fixture-84-chat-drawer'
const SESSION_ID = 'sess-84'
const CONDUCTOR_DIR = '/tmp/rhizomorph-fixture/conductor'

function laneEvents() {
  const f = createEventFactory()
  return [
    f.llmUsage({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
    f.toolActivity({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE, tool: 'Read' }),
  ]
}

describe('findLaneAttribution', () => {
  it('takes the newest attribution the log carries for the lane', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: LANE, sessionId: 'sess-old', worktreePath: WORKTREE }),
      f.llmUsage({ lane: 'other', sessionId: 'sess-other', worktreePath: '/elsewhere' }),
      f.toolActivity({ lane: LANE, sessionId: 'sess-new', worktreePath: WORKTREE }),
    ]

    expect(findLaneAttribution(events, LANE)).toEqual({
      sessionId: 'sess-new',
      worktreePath: WORKTREE,
    })
  })

  it('matches on branch too, since a lane id is its branch when one is known', () => {
    const f = createEventFactory()
    const events = [f.llmUsage({ lane: 'handle-84', branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE })]

    expect(findLaneAttribution(events, LANE)?.sessionId).toBe(SESSION_ID)
  })

  it('ignores telemetry that carries no session id — the file cannot be located from it', () => {
    const f = createEventFactory()
    const events = [f.llmCost({ lane: LANE, sessionId: null, worktreePath: null }, { source: 'otel' })]

    expect(findLaneAttribution(events, LANE)).toBeNull()
  })

  it('is null for a lane nothing ever named', () => {
    expect(findLaneAttribution(laneEvents(), 'no-such-lane')).toBeNull()
  })

  it('#208: keeps the worktree path already resolved when a later, same-session cost row carries none', () => {
    // Sessionlog attributes the lane while it is live. Then the lane lands —
    // `workmux merge` prunes the worktree — and OTel cost telemetry for the
    // same Claude Code session keeps arriving anyway, worktree-blind by
    // construction (`collectors/otel/parse-metrics.ts`).
    const f = createEventFactory()
    const events = [
      f.toolActivity({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
      f.llmCost({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: null }, { source: 'otel' }),
    ]

    expect(findLaneAttribution(events, LANE)).toEqual({ sessionId: SESSION_ID, worktreePath: WORKTREE })
  })

  it('#208: never invents a worktree path — stays null when nothing under this session ever named one', () => {
    const f = createEventFactory()
    const events = [f.llmCost({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: null }, { source: 'otel' })]

    expect(findLaneAttribution(events, LANE)).toEqual({ sessionId: SESSION_ID, worktreePath: null })
  })

  it('#208: a resumed session (new session id) gets its own worktree path, not the old session\'s', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: 'sess-old', worktreePath: WORKTREE }),
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: 'sess-new', worktreePath: '/tmp/other-wt' }),
    ]

    expect(findLaneAttribution(events, LANE)).toEqual({ sessionId: 'sess-new', worktreePath: '/tmp/other-wt' })
  })
})

describe('findConductorAttribution (prd6 ruling 5)', () => {
  it('finds the conductor by its declared role, whatever handle it was given', () => {
    // `--extra-sessions <dir>:orchestrator` — the handle is the operator's, the
    // role is the collector's. Matching on the name would find nothing here.
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
      f.llmUsage({
        lane: 'orchestrator',
        role: 'conductor',
        sessionId: 'sess-conductor',
        worktreePath: CONDUCTOR_DIR,
      }),
    ]

    expect(findConductorAttribution(events)).toEqual({
      sessionId: 'sess-conductor',
      worktreePath: CONDUCTOR_DIR,
    })
  })

  it('takes the newest conductor attribution, not the first', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: 'conductor', role: 'conductor', sessionId: 'sess-old', worktreePath: CONDUCTOR_DIR }),
      f.llmCost({ lane: 'conductor', role: 'conductor', sessionId: 'sess-new', worktreePath: CONDUCTOR_DIR }),
    ]

    expect(findConductorAttribution(events)?.sessionId).toBe('sess-new')
  })

  it('is null when every row is a worker — a lane named conductor proves nothing', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: 'conductor', role: 'worker', sessionId: 'sess-x', worktreePath: WORKTREE }),
    ]

    expect(findConductorAttribution(events)).toBeNull()
  })

  it('ignores conductor telemetry that carries no session id', () => {
    const f = createEventFactory()
    const events = [
      f.llmCost({ lane: 'conductor', role: 'conductor', sessionId: null, worktreePath: null }, { source: 'otel' }),
    ]

    expect(findConductorAttribution(events)).toBeNull()
  })

  it('#208: keeps the conductor\'s resolved worktree path when a later cost row for the same session carries none', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: 'conductor', role: 'conductor', sessionId: 'sess-conductor', worktreePath: CONDUCTOR_DIR }),
      f.llmCost(
        { lane: 'conductor', role: 'conductor', sessionId: 'sess-conductor', worktreePath: null },
        { source: 'otel' },
      ),
    ]

    expect(findConductorAttribution(events)).toEqual({ sessionId: 'sess-conductor', worktreePath: CONDUCTOR_DIR })
  })
})

describe('candidateTranscriptPaths', () => {
  it('offers the slug-inferred project dir first, then the dir-first extra-sessions location', () => {
    expect(
      candidateTranscriptPaths({ sessionId: SESSION_ID, worktreePath: WORKTREE }, '/tmp/rhizomorph-fixture/projects'),
    ).toEqual([
      path.join('/tmp/rhizomorph-fixture/projects', PROJECT_SLUG, `${SESSION_ID}.jsonl`),
      path.join(WORKTREE, `${SESSION_ID}.jsonl`),
    ])
  })

  it('offers nothing when no worktree path was recorded', () => {
    expect(candidateTranscriptPaths({ sessionId: SESSION_ID, worktreePath: null }, '/tmp/rhizomorph-fixture/projects')).toEqual([])
  })

  it('resolves a legitimate UUID session id exactly like any other bare filename', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'

    expect(candidateTranscriptPaths({ sessionId: uuid, worktreePath: WORKTREE }, '/tmp/rhizomorph-fixture/projects')).toEqual([
      path.join('/tmp/rhizomorph-fixture/projects', PROJECT_SLUG, `${uuid}.jsonl`),
      path.join(WORKTREE, `${uuid}.jsonl`),
    ])
  })

  it('refuses a session id built to escape claudeProjectsRoot with a relative traversal', () => {
    expect(
      candidateTranscriptPaths(
        { sessionId: '../../../../etc/passwd', worktreePath: WORKTREE },
        '/tmp/rhizomorph-fixture/projects',
      ),
    ).toEqual([])
  })

  it('refuses a session id that is itself an absolute path', () => {
    expect(
      candidateTranscriptPaths({ sessionId: '/etc/passwd', worktreePath: WORKTREE }, '/tmp/rhizomorph-fixture/projects'),
    ).toEqual([])
  })

  it('refuses a session id carrying an embedded NUL byte', () => {
    expect(
      candidateTranscriptPaths({ sessionId: 'sess-84\0.evil', worktreePath: WORKTREE }, '/tmp/rhizomorph-fixture/projects'),
    ).toEqual([])
  })
})

describe('allAttributedLanes', () => {
  it('finds every worker lane the log ever attributed to a session, deduplicated', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE }),
      f.toolActivity({ lane: LANE, branch: LANE, sessionId: SESSION_ID, worktreePath: WORKTREE, tool: 'Read' }),
      f.llmUsage({ lane: 'other-lane', branch: 'other-lane', sessionId: 'sess-other', worktreePath: '/wt/other' }),
    ]

    const found = allAttributedLanes(events)
    expect(found.map((entry) => entry.lane).sort()).toEqual(['84-chat-drawer', 'other-lane'])
    expect(found.find((entry) => entry.lane === LANE)?.attribution).toEqual({
      sessionId: SESSION_ID,
      worktreePath: WORKTREE,
    })
  })

  it('includes the conductor as CONDUCTOR_LANE, by role rather than by name', () => {
    const f = createEventFactory()
    const events = [
      f.llmUsage({ lane: 'orchestrator', role: 'conductor', sessionId: 'sess-conductor', worktreePath: CONDUCTOR_DIR }),
    ]

    expect(allAttributedLanes(events)).toEqual([
      { lane: CONDUCTOR_LANE, attribution: { sessionId: 'sess-conductor', worktreePath: CONDUCTOR_DIR } },
    ])
  })

  it('is empty for a session that never attributed anything — nothing to capture', () => {
    const f = createEventFactory()
    expect(allAttributedLanes([f.sessionStarted({})])).toEqual([])
  })

  it('never lists a lane whose only rows carry no session id', () => {
    const f = createEventFactory()
    const events = [f.llmCost({ lane: LANE, sessionId: null, worktreePath: null }, { source: 'otel' })]

    expect(allAttributedLanes(events)).toEqual([])
  })
})

describe('capturedTranscriptPath', () => {
  it('nests the captured file under transcripts/<recordingSessionId>, named by the claude session id', () => {
    expect(
      capturedTranscriptPath('/data/repo-abc', '1700000000000', { sessionId: SESSION_ID, worktreePath: WORKTREE }),
    ).toBe(path.join('/data/repo-abc', 'transcripts', '1700000000000', `${SESSION_ID}.jsonl`))
  })

  it('refuses a recording session id shaped like a traversal attempt', () => {
    expect(
      capturedTranscriptPath('/data/repo-abc', '../../etc', { sessionId: SESSION_ID, worktreePath: WORKTREE }),
    ).toBeNull()
  })

  it('refuses a claude session id shaped like a traversal attempt', () => {
    expect(
      capturedTranscriptPath('/data/repo-abc', '1700000000000', {
        sessionId: '../../../../etc/passwd',
        worktreePath: WORKTREE,
      }),
    ).toBeNull()
  })
})

/**
 * #422: `isPathContained` was `path.resolve`-only — it never chased a
 * symlink, so a session file that was itself a symlink escaping the
 * projects root passed on its own un-followed spelling. These tests need a
 * real filesystem (the earlier tests above are string-only, which is exactly
 * how the defect stayed invisible), so they get their own fixture.
 */
describe('isPathContained (#422): fail-closed over the shared containment primitive', () => {
  let root: string

  beforeEach(async () => {
    // Canonicalized at creation, deliberately: os.tmpdir() is a symlink on
    // macOS (`/var` -> `/private/var`) and is not on Linux. Leaving `root`
    // raw would let a raw-vs-canonical comparison inside THIS test — which
    // is exactly what containment is about — pass vacuously on ubuntu and
    // red only the macOS leg (paths/containment.test.ts's note, same trap).
    root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'transcript-attribution-containment-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'refuses a session file that is a symlink escaping claudeProjectsRoot — followed before this ' +
      "fix, refused after (mutation: reverting to path.resolve-only turns this red)",
    async () => {
      const claudeProjectsRoot = path.join(root, 'projects')
      const slugDir = path.join(claudeProjectsRoot, 'some-slug')
      const outsideDir = path.join(root, 'outside')
      await mkdir(slugDir, { recursive: true })
      await mkdir(outsideDir, { recursive: true })

      const secret = path.join(outsideDir, 'secret.jsonl')
      await writeFile(secret, 'not this reader\'s to see')
      const escapingSessionFile = path.join(slugDir, 'sess-escape.jsonl')
      await symlink(secret, escapingSessionFile)

      expect(isPathContained(claudeProjectsRoot, escapingSessionFile)).toBe(false)
    },
  )

  it('still contains an ordinary session file that is not a symlink at all', async () => {
    const claudeProjectsRoot = path.join(root, 'projects')
    const slugDir = path.join(claudeProjectsRoot, 'some-slug')
    await mkdir(slugDir, { recursive: true })
    const ordinary = path.join(slugDir, 'sess-ok.jsonl') // does not exist yet — capture writes it later

    expect(isPathContained(claudeProjectsRoot, ordinary)).toBe(true)
  })

  it('fails closed — refuses, never throws — on an ELOOP-shaped path', async () => {
    const dir = path.join(root, 'x')
    await mkdir(dir, { recursive: true })
    const link = path.join(dir, 'link')
    // Traverses a MISSING directory back to itself — realpath(3) reports
    // this as ENOENT, not ELOOP, so paths/containment.ts's bounded chase is
    // what turns it into ELOOP rather than an infinite, synchronous spin.
    await symlink(path.join('.', 'missing', '..', 'link'), link)

    expect(() => isPathContained(root, link)).not.toThrow()
    expect(isPathContained(root, link)).toBe(false)
  })
})
