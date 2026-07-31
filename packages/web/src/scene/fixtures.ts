import { createEvent, createIdFactory, type ObservatoryEvent } from '@observatory/core'

/**
 * A swarm-shaped event log, built with `core`'s own `createEvent` so every
 * fixture is schema-validated exactly like a collector's output.
 *
 * The scene renders live stream data whenever there is any; this is what it
 * shows before the first event arrives, and what the tests build against.
 * Deliberately sized at the performance target: 10 worktrees, ~200 commits.
 */

export const FIXTURE_WORKTREE_COUNT = 10

interface Spec {
  slug: string
  branch: string
  commits: number
  /** Seconds since `now` of the station's last sign of life. */
  quietFor: number
  status: 'working' | 'waiting' | 'done'
  dirty: number
  removed?: boolean
}

const SPECS: Spec[] = [
  { slug: '1-scaffold', branch: '1-scaffold', commits: 14, quietFor: 6, status: 'working', dirty: 3 },
  { slug: '2-core', branch: '2-core-events', commits: 31, quietFor: 2, status: 'working', dirty: 5 },
  { slug: '3-selectors', branch: '3-selectors', commits: 22, quietFor: 20, status: 'working', dirty: 1 },
  { slug: '4-collectors', branch: '4-git-collector', commits: 27, quietFor: 75, status: 'waiting', dirty: 2 },
  { slug: '5-server', branch: '5-server-sse', commits: 18, quietFor: 9, status: 'working', dirty: 0 },
  { slug: '6-worktrees', branch: '6-panel-worktrees', commits: 12, quietFor: 240, status: 'waiting', dirty: 4 },
  { slug: '7-collisions', branch: '7-panel-collisions', commits: 16, quietFor: 4, status: 'working', dirty: 2 },
  { slug: '8-ticker', branch: '8-panel-ticker', commits: 9, quietFor: 420, status: 'waiting', dirty: 0 },
  { slug: '9-replay', branch: '9-replay', commits: 21, quietFor: 12, status: 'working', dirty: 6 },
  { slug: '12-scene', branch: '12-scene', commits: 24, quietFor: 1, status: 'working', dirty: 8 },
  { slug: '0-spike', branch: '0-spike', commits: 5, quietFor: 900, status: 'done', dirty: 0, removed: true },
]

const REPO_PATH = '/home/demo/observatory'
const MAIN_COMMITS = 11

const MESSAGES = [
  'feat(core): event envelope + zod schemas',
  'test: fixture-driven parser cases',
  'refactor: pull selector out of the panel',
  'fix: guard against a detached HEAD',
  'chore: pin versions in architecture.md',
  'feat(web): dark neon tokens',
  'perf: instance the commit beads',
  'docs: note the read-only promise',
  'feat(server): SSE replay-from-offset',
  'fix(tmux): pane id parsing on wrapped output',
]

const AUTHORS = ['claude/opus', 'claude/sonnet', 'Jordan Rivera']

/**
 * @param now epoch ms the log should look "current" relative to. Defaults to
 * wall clock so the demo shows live pulses; pass a constant in tests.
 */
export function fixtureEvents(now: number = Date.now()): ObservatoryEvent[] {
  const nextId = createIdFactory('fx')
  const random = seeded(0x0b5e12)
  const events: ObservatoryEvent[] = []
  // Timestamps are epoch ms and the envelope rejects negatives, so a tiny
  // `now` (only ever a test's) still has to produce a valid log.
  const sessionStart = Math.max(0, now - 45 * 60_000)

  events.push(
    createEvent(
      'session.started',
      {
        sessionId: 'fixture',
        repoPath: REPO_PATH,
        repoName: 'observatory',
        mainBranch: 'main',
      },
      { id: nextId(), ts: sessionStart },
    ),
    createEvent(
      'worktree.discovered',
      { path: REPO_PATH, branch: 'main', head: 'main-head', isMain: true },
      { id: nextId(), ts: sessionStart },
    ),
  )

  for (let index = 0; index < MAIN_COMMITS; index += 1) {
    const ts = sessionStart + Math.round(((index + 1) / MAIN_COMMITS) * 40 * 60_000)
    events.push(commit(nextId, random, 'main', REPO_PATH, `main-${index}`, ts))
  }

  for (const spec of SPECS) {
    const path = `${REPO_PATH}__worktrees/${spec.slug}`
    const paneId = `%${100 + SPECS.indexOf(spec)}`
    const discoveredAt = sessionStart + 60_000 + SPECS.indexOf(spec) * 20_000

    events.push(
      createEvent(
        'worktree.discovered',
        { path, branch: spec.branch, head: `${spec.slug}-head`, isMain: false },
        { id: nextId(), ts: discoveredAt },
      ),
      createEvent(
        'pane.discovered',
        {
          paneId,
          sessionName: 'observatory',
          windowName: spec.slug,
          currentPath: path,
          worktreePath: path,
        },
        { id: nextId(), ts: discoveredAt },
      ),
    )

    const lastSeen = Math.max(0, now - spec.quietFor * 1_000)
    const span = Math.max(lastSeen - discoveredAt, 60_000)

    for (let index = 0; index < spec.commits; index += 1) {
      const ts = discoveredAt + Math.round(((index + 1) / spec.commits) * span)
      events.push(commit(nextId, random, spec.branch, path, `${spec.slug}-${index}`, ts))
    }

    if (spec.dirty > 0) {
      events.push(
        createEvent(
          'worktree.dirty',
          {
            path,
            branch: spec.branch,
            files: Array.from({ length: spec.dirty }, (_unused, index) => ({
              path: `packages/${spec.slug}/src/file-${index}.ts`,
              status: 'modified' as const,
            })),
          },
          { id: nextId(), ts: lastSeen },
        ),
      )
    }

    events.push(
      createEvent(
        'branch.updated',
        {
          branch: spec.branch,
          head: `${spec.slug}-head`,
          worktreePath: path,
          aheadOfMain: spec.commits,
          behindMain: 0,
        },
        { id: nextId(), ts: lastSeen },
      ),
      createEvent(
        'agent.status',
        { handle: spec.slug, status: spec.status, worktreePath: path, branch: spec.branch },
        { id: nextId(), ts: lastSeen },
      ),
      createEvent(
        'pane.activity',
        { paneId, contentHash: `hash-${spec.slug}`, preview: 'running npm test…' },
        { id: nextId(), ts: lastSeen },
      ),
    )

    if (spec.removed) {
      // Recent enough that the demo shows the convergence animation once.
      events.push(
        createEvent('worktree.removed', { path }, { id: nextId(), ts: Math.max(0, now - 1_500) }),
      )
    }
  }

  return events.sort((a, b) => a.ts - b.ts)
}

function commit(
  nextId: () => string,
  random: () => number,
  branch: string,
  worktreePath: string,
  sha: string,
  ts: number,
): ObservatoryEvent {
  const fileCount = 1 + Math.floor(random() * 5)
  return createEvent(
    'commit.landed',
    {
      sha,
      branch,
      message: pick(MESSAGES, random),
      author: { name: pick(AUTHORS, random) },
      authoredAt: ts,
      worktreePath,
      files: Array.from({ length: fileCount }, (_unused, index) => ({
        path: `packages/core/src/touched-${index}.ts`,
        status: 'modified' as const,
        insertions: Math.floor(random() * 40),
        deletions: Math.floor(random() * 20),
      })),
      insertions: Math.floor(random() * 120),
      deletions: Math.floor(random() * 60),
    },
    { id: nextId(), ts },
  )
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)] as T
}

/** Tiny LCG — fixtures must be byte-identical between runs. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}
