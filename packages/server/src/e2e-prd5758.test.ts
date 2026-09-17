import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildFleet, createCollectorContext, createEvent, parseStreamFrame, reduceAll } from '@rhizomorph/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runHookCommand } from './cli/hook.js'
import { createBeaconCollector } from './collectors/beacon/collector.js'
import { parseBeaconLine } from './collectors/beacon/parse-beacon-line.js'
import { beaconLineBelongsTo } from './collectors/beacon/paths.js'
import { repoSlug } from './log/paths.js'
import { canonicalize } from './paths/containment.js'
import { createRepoRootResolver } from './paths/repo-root.js'
import { createColonyDiscovery } from './server/colonies.js'
import { exec as realExec } from './server/exec.js'

/**
 * END TO END: prd-57 AND prd-58 TOGETHER, on real directories.
 *
 * Each PRD has its own suites and each passes. This asks the question neither
 * of them can: **does the machine prd-57 built still work once prd-58 makes it
 * watch more than one repo?**
 *
 * That is the question this repo has learned to ask the hard way. prd-57's most
 * expensive defect was a witness that was built, ranked, obeyed and fed by
 * nothing, and it survived three waves of green tests because every test handed
 * one half of a seam a well-formed input from the other half. The seams here
 * are the ones neither PRD owns:
 *
 * - prd-57's hook writes a beacon naming no lane; prd-58 must still route and
 *   join it, in the right colony.
 * - prd-57's process witness places actors; prd-58's discovery must group them
 *   into repos without losing the placement prd-57 depends on.
 * - prd-58's frame envelope must still deliver a prd-57 event to a fold that
 *   has never heard of colonies.
 */

let root: string
let alpha: string
let alphaWt: string
let beta: string
let betaWt: string
let dataRoot: string

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

beforeAll(async () => {
  root = canonicalize(await mkdtemp(path.join(tmpdir(), 'prd5758-e2e-')))
  dataRoot = path.join(root, 'data')
  await mkdir(dataRoot, { recursive: true })

  for (const name of ['alpha', 'beta']) {
    const dir = path.join(root, name)
    await mkdir(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    await writeFile(path.join(dir, 'f.txt'), 'v1\n')
    git(dir, ['add', '.'])
    git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  }
  alpha = path.join(root, 'alpha')
  beta = path.join(root, 'beta')
  alphaWt = path.join(root, 'alpha-wt')
  git(alpha, ['worktree', 'add', '-q', alphaWt, '-b', 'side'])
  // Beta gets a worktree too: the main checkout is not a LANE, and an agent
  // working in a repo works in one of its worktrees.
  betaWt = path.join(root, 'beta-wt')
  git(beta, ['worktree', 'add', '-q', betaWt, '-b', 'work'])
}, 120_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function actorAt(pid: number, worktreePath: string) {
  return {
    pid,
    dialect: 'claude' as const,
    startedAt: 1_000,
    worktreePath,
    placement: 'rooted' as const,
    parentPid: null,
    cpuMsDelta: null,
    rssBytes: null,
    seenAt: 1_000,
    goneAt: null,
    goneReason: null,
  }
}

describe('prd-57 + prd-58 end to end, on real repositories', () => {
  it('SEAM 1: the process witness places agents, and discovery groups them into colonies', async () => {
    // prd-57 ruling 1 gives the placement; prd-58 ruling 1 turns it into the
    // watched set. Three placed agents, one of them in a linked worktree of the
    // first repo, must be TWO colonies.
    const discovery = createColonyDiscovery({
      pinnedRepoPath: alpha,
      resolver: createRepoRootResolver(realExec),
    })

    const colonies = await discovery.discover([
      actorAt(4001, alpha),
      actorAt(4002, alphaWt),
      actorAt(4003, beta),
    ])

    expect(colonies.map((c) => c.path)).toEqual([alpha, beta])
    expect(colonies[0]?.pinned).toBe(true)
    // The slug is the recorder's own, so the colony and its recording agree.
    expect(colonies.map((c) => c.id)).toEqual([repoSlug(alpha), repoSlug(beta)])
  }, 60_000)

  it("SEAM 2: a prd-57 hook firing in a SECOND colony reaches that colony's lane", async () => {
    /**
     * The whole point of both PRDs meeting.
     *
     * prd-57: `rhizomorph hook` fires inside the agent's own process and cannot
     * name a lane, so the fold joins it by pid against the actor the process
     * witness placed. prd-58: that agent is in a repo the instrument was never
     * started in.
     *
     * Every link is real here — the runner, the door, the routing rule, the
     * collector, the fold, the fleet. Nothing is hand-built.
     */
    const AT = Date.UTC(2026, 8, 18, 12, 0, 0)

    // 1. prd-57's runner writes, from inside BETA — not the pinned repo.
    expect(
      await runHookCommand(
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: '11111111-2222-4333-8444-555555555555',
          transcript_path: '/home/operator/.claude/projects/beta/session.jsonl',
          cwd: betaWt,
        }),
        { dataRoot, parentPid: 4003, now: () => AT },
      ),
    ).toBe(0)

    // 2. prd-57's parser reads it back, and it names no lane.
    const doorFile = path.join(dataRoot, 'beacons', 'claude-hook.jsonl')
    const line = (await readFile(doorFile, 'utf8')).trim().split('\n').at(-1) as string
    const parsed = parseBeaconLine(line)
    expect(parsed.kind).toBe('beacon')
    if (parsed.kind !== 'beacon') return
    expect(parsed.payload.lane).toBeNull()
    expect(parsed.payload.pid).toBe(4003)

    // 3. prd-57's routing rule admits it for BETA and refuses it for ALPHA.
    //    This is the seam: one shared door, two colonies, and the line belongs
    //    to exactly one of them.
    expect(beaconLineBelongsTo(beta, parsed.payload.cwd)).toBe(true)
    expect(beaconLineBelongsTo(alpha, parsed.payload.cwd)).toBe(false)

    // 4. prd-57's real collector, ticked over beta's own door.
    const collector = createBeaconCollector({ dataRoot })
    let next = 0
    const result = await collector.poll(
      collector.initialSnapshot(),
      createCollectorContext({
        repoPath: beta,
        now: AT,
        exec: async () => {
          throw new Error('the beacon collector must never exec')
        },
        nextId: () => `beacon-${(next += 1)}`,
      }),
    )
    const beacons = result.events.filter((e) => e.type === 'beacon.received')
    expect(beacons.length).toBeGreaterThan(0)

    // 5. prd-57's fold and fleet, for BETA's colony.
    let id = 0
    const evt = (type: string, payload: unknown, ts: number) =>
      createEvent(type as never, payload as never, { id: `e${(id += 1)}`, ts })

    const fleet = buildFleet(
      reduceAll([
        evt('session.started', { sessionId: 'beta-1', repoPath: beta, repoName: 'beta' }, AT - 900_000),
        evt('worktree.discovered', { path: beta, branch: 'main', head: 'sha-b', isMain: true }, AT - 900_000),
        evt('worktree.discovered', { path: betaWt, branch: 'work', head: 'sha-w', isMain: false }, AT - 900_000),
        evt(
          'process.seen',
          { pid: 4003, dialect: 'claude', startedAt: AT - 300_000, worktreePath: betaWt, placement: 'rooted', parentPid: null },
          AT - 300_000,
        ),
        ...result.events,
      ]),
      { now: AT + 40_000 },
    )

    // THE ANSWER: a hook fired in a repo the instrument never started in
    // reaches that repo's lane, joined by pid, with the join voiced.
    const lane = fleet.lanes.find((candidate) => candidate.worktreePath === betaWt)
    expect(lane?.declared).toMatchObject({ kind: 'working', joinedBy: 'pid', writer: 'claude-hook' })
  }, 60_000)

  it('SEAM 3: a prd-58 frame delivers a prd-57 event to a fold that never heard of colonies', () => {
    // The envelope is the one thing every event now passes through. If it
    // dropped or reshaped an event, prd-57's whole fold would be reading
    // something else — and no prd-57 test would notice, because they never see
    // a frame.
    const event = createEvent(
      'process.seen' as never,
      { pid: 77, dialect: 'claude', startedAt: 1, worktreePath: beta, placement: 'rooted', parentPid: null } as never,
      { id: 'e-frame', ts: 5_000 },
    )

    const framed = parseStreamFrame({ colony: repoSlug(beta), event })
    expect(framed?.colony).toBe(repoSlug(beta))
    // Byte-identical: the envelope carries, it does not touch.
    expect(framed?.event).toEqual(event)

    // And prd-57's fold reads it exactly as it always did.
    const state = reduceAll([framed?.event as never])
    expect(Object.values(state.processes)[0]).toMatchObject({ pid: 77, worktreePath: beta })
  })

  it('SEAM 4: colonies do not leak — beta\'s hook never reaches alpha', async () => {
    // The failure that would be invisible to both PRDs' own suites: a beacon
    // folded into every colony would make every lane in every repo declare
    // whatever any agent said. The routing rule is what stops it, and this
    // asserts the negative rather than trusting it.
    const AT = Date.UTC(2026, 8, 18, 13, 0, 0)
    const collector = createBeaconCollector({ dataRoot })
    let next = 0
    const forAlpha = await collector.poll(
      collector.initialSnapshot(),
      createCollectorContext({
        repoPath: alpha,
        now: AT,
        exec: async () => {
          throw new Error('never')
        },
        nextId: () => `a-${(next += 1)}`,
      }),
    )

    // Beta's line is in the shared door, and alpha's collector must not take it.
    const beacons = forAlpha.events.filter((e) => e.type === 'beacon.received')
    for (const beacon of beacons) {
      expect((beacon.payload as { cwd?: string }).cwd).not.toBe(betaWt)
    }
  }, 60_000)
})
