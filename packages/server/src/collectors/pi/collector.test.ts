import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, type CollectorContext, type Exec } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPiCollector } from './collector.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Every real capture reports this `cwd` on its header line. */
const CAPTURE_CWD = '/repo-wt/pi-capture'

/**
 * `git worktree list --porcelain`, main working tree first — the ordering git
 * itself guarantees, and the one the collector's scope depends on.
 */
function worktrees(...paths: readonly string[]): Exec {
  const stdout = paths.map((p) => `worktree ${p}\nHEAD 0000000000000000000000000000000000000000\n`).join('\n')
  return async () => ({ stdout, stderr: '', code: 0, failed: false })
}

/** The default scope for these tests: `/repo` is the main tree, the captures' own worktree is a worker. */
const WATCHED: Exec = worktrees('/repo', CAPTURE_CWD)

/** `git worktree list` itself failing — not an empty answer, a failed one. */
const GIT_BROKEN: Exec = async () => ({ stdout: '', stderr: 'not a git repository', code: 128, failed: true })

/**
 * A real capture, replayed with its header's `cwd` (and optionally its session
 * id) rewritten. Only line 1 changes — every message line stays exactly as
 * captured, so what these tests drive is still pi's own transcript shape.
 */
async function captureAt(name: string, cwd: string, sessionId?: string): Promise<string> {
  const raw = await readFile(path.join(fixturesDir, name), 'utf8')
  const [headerLine, ...rest] = raw.split('\n')
  const header = JSON.parse(headerLine!) as Record<string, unknown>
  return [JSON.stringify({ ...header, cwd, ...(sessionId === undefined ? {} : { id: sessionId }) }), ...rest].join('\n')
}

function makeContext(exec: Exec, now = 2_000): CollectorContext {
  let counter = 0
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId: () => `id-${(counter += 1)}`,
    emit: (type, payload, options) =>
      createEvent(type, payload, { id: `id-${(counter += 1)}`, ts: options?.ts === undefined ? now : Math.floor(options.ts) }),
  }
}

describe('createPiCollector', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pi-collector-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('disables itself, once, when the pi sessions root does not exist', async () => {
    const missingRoot = path.join(root, 'does-not-exist')
    const collector = createPiCollector({ piSessionsRoot: missingRoot })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    expect(result.nextSnapshot.disabled).toBe(true)
    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'collector.disabled',
        payload: { collector: 'pi', reason: `no pi session directory at ${missingRoot}` },
      }),
    ])
  })

  it('a real turn-complete session: llm.usage and llm.cost carry harness "pi", the header cwd as lane, and no tool.activity', async () => {
    await writeFile(
      path.join(root, 'turn-complete.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    const usage = result.events.filter((event) => event.type === 'llm.usage')
    const cost = result.events.filter((event) => event.type === 'llm.cost')
    const activity = result.events.filter((event) => event.type === 'tool.activity')

    expect(usage).toHaveLength(1)
    expect(usage[0]!.source).toBe('sessionlog')
    expect(usage[0]!.payload).toMatchObject({
      lane: 'pi-capture',
      sessionId: '00000000-0000-0000-0000-000000000000',
      worktreePath: '/repo-wt/pi-capture',
      branch: null,
      harness: 'pi',
      model: 'anthropic/claude-haiku-4.5',
      tokens: { input: 1974, output: 38, cacheRead: 0, cacheCreation: 0 },
    })

    expect(cost).toHaveLength(1)
    expect(cost[0]!.source).toBe('sessionlog')
    expect(cost[0]!.payload).toMatchObject({
      lane: 'pi-capture',
      harness: 'pi',
      costUsd: 0.002164,
      authoritative: true,
    })

    expect(activity).toHaveLength(0)
  })

  it('a real tool-call session: one tool.activity for the bash call, two llm.usage/llm.cost pairs (open + close)', async () => {
    await writeFile(
      path.join(root, 'tool-call.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-tool-call.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    expect(result.events.filter((event) => event.type === 'llm.usage')).toHaveLength(2)
    expect(result.events.filter((event) => event.type === 'llm.cost')).toHaveLength(2)

    const activity = result.events.filter((event) => event.type === 'tool.activity')
    expect(activity).toHaveLength(1)
    expect(activity[0]!.payload).toMatchObject({
      lane: 'pi-capture',
      tool: 'bash',
      harness: 'pi',
      filePath: null,
      toolUseId: 'toolu_bdrk_016XrSLLjoF4jw1vmVpAKdwp',
    })
  })

  it('a real write-tool session: tool.activity carries the file tool\'s own "path" argument, repo-relative to the worktree', async () => {
    await writeFile(
      path.join(root, 'write-tool.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-write-tool.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    const activity = result.events.filter((event) => event.type === 'tool.activity')
    expect(activity.length).toBeGreaterThan(0)
    const write = activity.find((event) => (event.payload as { tool: string }).tool === 'write')
    expect(write).toBeDefined()
    const filePath = (write!.payload as { filePath: string | null }).filePath
    expect(filePath).not.toBeNull()
    expect(path.isAbsolute(filePath!)).toBe(false)
  })

  it('backfill defaults to off: a session already on disk before first sight is not read from byte 0', async () => {
    await writeFile(
      path.join(root, 'turn-complete.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    expect(result.events.filter((event) => event.type === 'llm.usage' || event.type === 'llm.cost')).toHaveLength(0)
  })

  it('walks nested directories under the root — no directory-naming convention is assumed', async () => {
    const nested = path.join(root, 'some-cwd-slug', 'deeper')
    await mkdir(nested, { recursive: true })
    await writeFile(
      path.join(nested, 'session.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-turn-complete.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    expect(result.events.some((event) => event.type === 'llm.usage')).toBe(true)
  })

  it('a session whose header carries no readable cwd is skipped, never crashed on and never guessed at', async () => {
    await writeFile(
      path.join(root, 'headerless.jsonl'),
      '{"type":"message","id":"a","parentId":null,"timestamp":"2026-08-14T05:31:58.969Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1786685518968}}\n',
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    expect(result.events).toEqual([])
    expect(result.nextSnapshot.disabled).toBe(false)
    expect(result.nextSnapshot.lanes).toEqual({})
    // Nothing cached either — an unreadable header is retried next poll, never
    // remembered as absent.
    expect(result.nextSnapshot.headers).toEqual({})
  })
})

/**
 * #609. `~/.pi/agent/sessions/` is machine-wide: it holds every pi session the
 * operator has ever run, in every project. The walk that finds them therefore
 * cannot be the thing that decides which ones are this repo's business — the
 * header `cwd` is, and these are the laws that says so.
 */
describe('createPiCollector — the walk is scoped to watched worktrees', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pi-scope-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('two unrelated projects sharing a leaf directory name do not collide — only the watched one is read at all', async () => {
    // The exact reproduction from the review: `/home/alice/client-a/api` and
    // `/srv/client-b/api` are two different projects that happen to share a
    // leaf name. Under an unscoped walk both keyed to lane `api`, and
    // `deriveLanes`' freshest-wins fold silently discarded one of them.
    await writeFile(
      path.join(root, 'watched.jsonl'),
      await captureAt('pi-0.83.0-turn-complete.jsonl', '/home/alice/client-a/api', 'session-a-111'),
      'utf8',
    )
    await writeFile(
      path.join(root, 'stranger.jsonl'),
      await captureAt('pi-0.83.0-tool-call.jsonl', '/srv/client-b/api', 'session-b-222'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(
      collector.initialSnapshot(),
      makeContext(worktrees('/repo', '/home/alice/client-a/api')),
    )

    const attributed = result.events.map((event) => event.payload as { lane: string; sessionId: string })
    expect(attributed.length).toBeGreaterThan(0)
    expect([...new Set(attributed.map((p) => p.lane))]).toEqual(['api'])
    // The point: every one of those `api` events is the watched project's.
    expect([...new Set(attributed.map((p) => p.sessionId))]).toEqual(['session-a-111'])

    // And the surviving lane reads off the watched session, not whichever file
    // happened to be written last.
    expect(Object.keys(result.nextSnapshot.lanes ?? {})).toEqual(['api'])
    expect(result.nextSnapshot.lanes!.api!.sessionFile).toBe(path.join(root, 'watched.jsonl'))
    expect(result.nextSnapshot.lanes!.api!.worktreePath).toBe('/home/alice/client-a/api')
    expect(Object.keys(result.nextSnapshot.files)).toEqual([path.join(root, 'watched.jsonl')])
  })

  it('a session in no watched worktree emits nothing, derives no lane, and is not tailed', async () => {
    await writeFile(
      path.join(root, 'stranger.jsonl'),
      await captureAt('pi-0.83.0-turn-complete.jsonl', '/srv/client-b/api'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(worktrees('/repo', CAPTURE_CWD)))

    expect(result.events).toEqual([])
    expect(result.nextSnapshot.files).toEqual({})
    expect(result.nextSnapshot.lanes).toEqual({})
    // Its header IS remembered, so rejecting it again next poll costs no read.
    expect(result.nextSnapshot.headers).toEqual({
      [path.join(root, 'stranger.jsonl')]: { cwd: '/srv/client-b/api', sessionId: '00000000-0000-0000-0000-000000000000' },
    })
  })

  it('a session started in a subdirectory resolves to its worktree root, not to the subdirectory', async () => {
    await writeFile(
      path.join(root, 'nested-cwd.jsonl'),
      await captureAt('pi-0.83.0-write-tool.jsonl', `${CAPTURE_CWD}/packages/server`),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    const usage = result.events.filter((event) => event.type === 'llm.usage')
    expect(usage.length).toBeGreaterThan(0)
    // Not lane `server`, which is what a bare basename of the session's own cwd
    // would have produced.
    expect(usage[0]!.payload).toMatchObject({ lane: 'pi-capture', worktreePath: CAPTURE_CWD })
  })

  it('the nearest enclosing worktree wins when one worktree is nested inside another', async () => {
    await writeFile(
      path.join(root, 'nested-worktree.jsonl'),
      await captureAt('pi-0.83.0-turn-complete.jsonl', '/repo/vendor/inner'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(
      collector.initialSnapshot(),
      makeContext(worktrees('/repo', '/repo/vendor/inner')),
    )

    const usage = result.events.filter((event) => event.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]!.payload).toMatchObject({ lane: 'inner', worktreePath: '/repo/vendor/inner', role: 'worker' })
  })

  it('the main working tree is the unattributed lane, never a lane of its own', async () => {
    await writeFile(path.join(root, 'main-tree.jsonl'), await captureAt('pi-0.83.0-turn-complete.jsonl', '/repo'), 'utf8')
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))

    const usage = result.events.filter((event) => event.type === 'llm.usage')
    expect(usage).toHaveLength(1)
    // Mirrors sessionlog (#62): the main tree is where a human drives the repo
    // directly, so its spend is a setup gap to fill in, never booked as worker.
    expect(usage[0]!.payload).toMatchObject({ lane: 'unattributed', worktreePath: '/repo', role: 'unattributed' })
  })

  it("git worktree list failing narrows the scope to the watched repo — it never opens it to the whole machine", async () => {
    await writeFile(path.join(root, 'in-repo.jsonl'), await captureAt('pi-0.83.0-turn-complete.jsonl', '/repo'), 'utf8')
    await writeFile(
      path.join(root, 'stranger.jsonl'),
      await captureAt('pi-0.83.0-tool-call.jsonl', '/srv/client-b/api'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const result = await collector.poll(collector.initialSnapshot(), makeContext(GIT_BROKEN))

    expect(result.nextSnapshot.disabled).toBe(false)
    expect(Object.keys(result.nextSnapshot.files)).toEqual([path.join(root, 'in-repo.jsonl')])
    expect(result.nextSnapshot.knownWorktrees).toEqual({ '/repo': 'unattributed' })
  })

  it("a worktree that has been removed keeps its transcript attributable (#165's fold, now load-bearing for scope)", async () => {
    await writeFile(
      path.join(root, 'landed.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-tool-call.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const first = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))
    expect(first.events.length).toBeGreaterThan(0)
    expect(first.nextSnapshot.knownWorktrees).toEqual({ '/repo': 'unattributed', [CAPTURE_CWD]: 'worker' })

    // The lane lands and its worktree is removed; the transcript under
    // `~/.pi` outlives it. Without the fold the scope check would drop it and
    // the lane would vanish from the fleet the moment its work finished.
    const second = await collector.poll(first.nextSnapshot, makeContext(worktrees('/repo'), 3_000))

    expect(second.nextSnapshot.knownWorktrees).toEqual({ '/repo': 'unattributed', [CAPTURE_CWD]: 'worker' })
    expect(Object.keys(second.nextSnapshot.lanes ?? {})).toEqual(['pi-capture'])
    expect(second.nextSnapshot.lanes!['pi-capture']!.worktreePath).toBe(CAPTURE_CWD)
  })

  it('a session that comes into scope only once its worktree appears is picked up then, and not before', async () => {
    await writeFile(
      path.join(root, 'later.jsonl'),
      await readFile(path.join(fixturesDir, 'pi-0.83.0-tool-call.jsonl'), 'utf8'),
      'utf8',
    )
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const first = await collector.poll(collector.initialSnapshot(), makeContext(worktrees('/repo')))
    expect(first.events).toEqual([])

    const second = await collector.poll(first.nextSnapshot, makeContext(WATCHED, 3_000))
    expect(second.events.filter((event) => event.type === 'llm.usage').length).toBeGreaterThan(0)
    expect(second.events.every((event) => (event.payload as { lane: string }).lane === 'pi-capture')).toBe(true)
  })

  it('the header cache is pruned to the files still on disk', async () => {
    const gone = path.join(root, 'gone.jsonl')
    await writeFile(gone, await captureAt('pi-0.83.0-turn-complete.jsonl', '/srv/client-b/api'), 'utf8')
    const collector = createPiCollector({ piSessionsRoot: root, backfill: true })

    const first = await collector.poll(collector.initialSnapshot(), makeContext(WATCHED))
    expect(Object.keys(first.nextSnapshot.headers ?? {})).toEqual([gone])

    await rm(gone)
    const second = await collector.poll(first.nextSnapshot, makeContext(WATCHED, 3_000))
    expect(second.nextSnapshot.headers).toEqual({})
  })
})
