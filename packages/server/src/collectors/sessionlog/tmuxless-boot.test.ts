import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionlogCollector } from './collector.js'
import { agentStatusEmissionFor, TRANSCRIPT_STALL_MS, TURN_SETTLE_MS, type LaneState } from './lane-state.js'
import type { ProcessLiveness, ProcessProbe } from './process-probe.js'
import type { LaneLiveness, SessionlogSnapshot } from './types.js'
import { worktreePathToProjectSlug } from './worktree-slug.js'

/**
 * **THE TMUXLESS BOOT — prd15's whole point, in miniature.**
 *
 * This suite runs the real sessionlog collector on a machine that has no tmux,
 * no workmux, and no cooperation of any kind from the agents it is watching:
 * the ONLY binary it may shell out to is `git`, and every other command fails
 * with ENOENT. From real Claude Code transcripts plus a stubbed process probe
 * it derives WORKING, WAITING, FROZEN and GONE per lane — the two signals the
 * agnosticism spike identified as the exact things that die without tmux
 * ("live pane liveness and the declared/inferred WAITING pathology"),
 * recovered with zero cooperation.
 *
 * Every transcript below is a real capture. The harness rewrites exactly two
 * things in it, mechanically: the `timestamp` fields (shifted by one constant
 * per file, so relative timing inside a real conversation is preserved) and
 * the lane identity (`cwd` / `gitBranch`), so one captured shape can stand in
 * for several lanes. Shapes are never edited.
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))
const CAPTURED_VERSION = 'claude-code-2.1.222'
const NOW = 1_800_000_000_000

/** Shapes captured from the corpus, by the state each one is used to prove. */
const TURN_COMPLETE = `${CAPTURED_VERSION}-tail-turn-complete.jsonl`
const PENDING_TOOL = `${CAPTURED_VERSION}-tail-pending-tool.jsonl`
const MID_STREAM = `${CAPTURED_VERSION}-tail-mid-stream.jsonl`
const AWAITING_REPLY = `${CAPTURED_VERSION}-tail-awaiting-reply.jsonl`
const METADATA_ONLY = `${CAPTURED_VERSION}-tail-metadata-only.jsonl`

/**
 * The whole hostile environment: `git worktree list` answers, and every other
 * binary on earth is missing. If anything in this organ ever reaches for tmux
 * or workmux, these tests stop passing.
 */
function tmuxlessExec(worktreePaths: readonly string[]): Exec {
  return async (command, args) => {
    if (command === 'git' && args[0] === 'worktree') {
      return {
        stdout: worktreePaths
          .map((worktreePath) => `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/main\n`)
          .join('\n'),
        stderr: '',
        code: 0,
        failed: false,
      }
    }
    return {
      stdout: '',
      stderr: '',
      code: null,
      failed: true,
      errorMessage: `spawn ${command} ENOENT`,
    } satisfies ExecResult
  }
}

function makeContext(exec: Exec, now = NOW): CollectorContext {
  let counter = 0
  return {
    repoPath: '/repo',
    now,
    exec,
    nextId: () => `id-${(counter += 1)}`,
    emit: (type, payload, options) =>
      createEvent(type, payload, {
        id: `id-${(counter += 1)}`,
        ts: options?.ts === undefined ? now : Math.floor(options.ts),
      }),
  }
}

/** A probe that answers from a table, and records what it was asked. */
function stubProbe(alive: Readonly<Record<string, ProcessLiveness>>): ProcessProbe & { asked: string[][] } {
  const asked: string[][] = []
  return {
    name: 'stub',
    asked,
    async probe(worktreePaths) {
      asked.push([...worktreePaths])
      return new Map(worktreePaths.map((worktreePath) => [worktreePath, alive[worktreePath] ?? false]))
    },
  }
}

describe('the tmuxless boot', () => {
  let root: string
  let claudeProjectsRoot: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sessionlog-tmuxless-'))
    claudeProjectsRoot = path.join(root, 'claude-projects')
    await mkdir(claudeProjectsRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const worktreeOf = (lane: string): string => path.join(root, 'wt', lane)

  /**
   * Plants one captured transcript as `lane`'s session, aged so its last
   * conversational entry sits `ageMs` before the tick.
   *
   * `writeAgeMs` sets the file's mtime independently — the heartbeat witness.
   * Pinning it rather than letting the filesystem stamp wall-clock time is
   * what makes these tests hermetic, and it is also the only way to model the
   * situation the organ exists to get right: a transcript whose *conversation*
   * stopped long ago while the CLI keeps appending bookkeeping to it.
   */
  async function plant(
    lane: string,
    fixture: string,
    ageMs: number,
    { writeAgeMs = 1_000, fileName = 'session-1.jsonl' }: { writeAgeMs?: number; fileName?: string } = {},
  ): Promise<void> {
    const raw = await readFile(path.join(FIXTURES_DIR, fixture), 'utf8')
    const lines = raw.split('\n').filter((line) => line.length > 0)

    const stamps = lines
      .map((line) => (JSON.parse(line) as { timestamp?: string }).timestamp)
      .filter((stamp): stamp is string => typeof stamp === 'string')
      .map((stamp) => Date.parse(stamp))
      .filter((stamp) => Number.isFinite(stamp))
    const latest = Math.max(...stamps)
    const shift = NOW - ageMs - latest

    const worktreePath = worktreeOf(lane)
    const aged = lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (typeof entry.timestamp === 'string') {
        entry.timestamp = new Date(Date.parse(entry.timestamp) + shift).toISOString()
      }
      if (typeof entry.cwd === 'string') entry.cwd = worktreePath
      if (typeof entry.gitBranch === 'string') entry.gitBranch = lane
      return JSON.stringify(entry)
    })

    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, fileName)
    await writeFile(filePath, `${aged.join('\n')}\n`)
    const written = new Date(NOW - writeAgeMs)
    await utimes(filePath, written, written)
  }

  async function boot(
    lanes: readonly string[],
    probe: ProcessProbe,
    now = NOW,
  ): Promise<SessionlogSnapshot> {
    const collector = createSessionlogCollector({
      claudeProjectsRoot,
      backfill: true,
      processProbe: probe,
    })
    const exec = tmuxlessExec(['/repo', ...lanes.map(worktreeOf)])
    const result = await collector.poll(collector.initialSnapshot(), makeContext(exec, now))
    return result.nextSnapshot
  }

  function stateOf(snapshot: SessionlogSnapshot, lane: string): LaneState | undefined {
    return snapshot.lanes?.[lane]?.state
  }

  it('derives all four states from real transcripts, with no tmux and no workmux anywhere', async () => {
    // The prd in one assertion. Four lanes, four transcripts captured from
    // real Claude Code sessions, one stubbed process table — and the full
    // liveness+attention picture the tmux rig used to be needed for.
    await plant('lane-working', PENDING_TOOL, 30_000)
    await plant('lane-waiting', TURN_COMPLETE, 5 * 60_000)
    await plant('lane-frozen', MID_STREAM, 30 * 60_000)
    await plant('lane-gone', AWAITING_REPLY, 30 * 60_000)

    const lanes = ['lane-working', 'lane-waiting', 'lane-frozen', 'lane-gone']
    const snapshot = await boot(
      lanes,
      stubProbe({
        [worktreeOf('lane-frozen')]: true,
        [worktreeOf('lane-gone')]: false,
        [worktreeOf('lane-waiting')]: true,
      }),
    )

    expect(stateOf(snapshot, 'lane-working')).toBe('working')
    expect(stateOf(snapshot, 'lane-waiting')).toBe('waiting')
    expect(stateOf(snapshot, 'lane-frozen')).toBe('frozen')
    expect(stateOf(snapshot, 'lane-gone')).toBe('gone')
  })

  it('never shells out to anything but git', async () => {
    const commands: string[] = []
    await plant('lane-a', TURN_COMPLETE, 5 * 60_000)
    const collector = createSessionlogCollector({
      claudeProjectsRoot,
      backfill: true,
      processProbe: stubProbe({}),
    })
    const inner = tmuxlessExec(['/repo', worktreeOf('lane-a')])
    const spy: Exec = async (command, args, options) => {
      commands.push(command)
      return inner(command, args, options)
    }
    await collector.poll(collector.initialSnapshot(), makeContext(spy))
    expect([...new Set(commands)]).toEqual(['git'])
  })

  it('carries both witnesses into every reading, never a resolved single one', async () => {
    // Ruling 2 at the level of one lane's own evidence: the shape, the work
    // silence, the write silence and the process answer all survive into the
    // reading, so a downstream voice can say what disagreed rather than being
    // handed a verdict.
    await plant('lane-frozen', MID_STREAM, 30 * 60_000, { writeAgeMs: 2_000 })
    const snapshot = await boot(['lane-frozen'], stubProbe({ [worktreeOf('lane-frozen')]: true }))
    const reading = snapshot.lanes?.['lane-frozen'] as LaneLiveness

    expect(reading.shape).toBe('mid-stream')
    expect(reading.quietMs).toBe(30 * 60_000)
    expect(reading.processAlive).toBe(true)
    // The conversation stopped half an hour ago; the file was touched two
    // seconds ago. The lane is FROZEN anyway — the heartbeat is reported, not
    // obeyed. This is the prd3 keystone bug, refused at its new door.
    expect(reading.writeQuietMs).toBe(2_000)
    expect(reading.evidence).toContain('FROZEN')
    expect(reading.sessionFile).toContain('session-1.jsonl')
  })

  it('does not summon a lane mid-subagent-delegation — the #133 corpus stays green', async () => {
    // A delegating lane: an open Task call, a transcript that has gone quiet
    // for exactly as long as its subagent is busiest, a live process. It must
    // read as work in progress, and above all must never raise a hand.
    await plant('lane-delegating', PENDING_TOOL, 4 * 60_000)
    const snapshot = await boot(
      ['lane-delegating'],
      stubProbe({ [worktreeOf('lane-delegating')]: true }),
    )
    expect(stateOf(snapshot, 'lane-delegating')).toBe('working')

    const emission = agentStatusEmissionFor({
      handle: 'lane-delegating',
      worktreePath: worktreeOf('lane-delegating'),
      branch: 'lane-delegating',
      previous: 'working',
      reading: snapshot.lanes?.['lane-delegating'] as LaneLiveness,
    })
    expect(emission).toBeNull()
  })

  it('probes only the lanes that have actually stalled', async () => {
    // The observer's footprint on a healthy fleet is zero reads outside the
    // transcripts it was already tailing.
    await plant('lane-busy', PENDING_TOOL, 10_000)
    await plant('lane-quiet', TURN_COMPLETE, 20 * 60_000)
    const probe = stubProbe({})
    await boot(['lane-busy', 'lane-quiet'], probe)

    expect(probe.asked).toHaveLength(1)
    expect(probe.asked[0]).toEqual([worktreeOf('lane-quiet')])
  })

  it('asks for no probe at all when every lane is moving', async () => {
    await plant('lane-a', PENDING_TOOL, 5_000)
    await plant('lane-b', MID_STREAM, 5_000)
    const probe = stubProbe({})
    await boot(['lane-a', 'lane-b'], probe)
    expect(probe.asked).toEqual([])
  })

  it('degrades to FROZEN, never to GONE, when the platform cannot probe', async () => {
    // The macOS / Windows-native path today: `null` from the probe. A stalled
    // lane is reported as stalled; nothing is declared dead on a gap.
    await plant('lane-stalled', MID_STREAM, 30 * 60_000)
    const unknownProbe: ProcessProbe = {
      name: 'unknown',
      probe: async (paths) => new Map(paths.map((p) => [p, null])),
    }
    const snapshot = await boot(['lane-stalled'], unknownProbe)
    expect(stateOf(snapshot, 'lane-stalled')).toBe('frozen')
    expect(snapshot.lanes?.['lane-stalled']?.processAlive).toBeNull()
  })

  it('derives nothing at all for a transcript of pure bookkeeping', async () => {
    // The honest gap: no conversational entry means no claim, not a default.
    // The capture carries no timestamps at all (it is two bookkeeping lines),
    // which is also the harshest input the derivation can be handed.
    const worktreePath = worktreeOf('lane-silent')
    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(worktreePath))
    await mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, 'session-1.jsonl')
    await writeFile(filePath, await readFile(path.join(FIXTURES_DIR, METADATA_ONLY), 'utf8'))
    await utimes(filePath, new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000))

    const snapshot = await boot(['lane-silent'], stubProbe({}))
    expect(snapshot.lanes?.['lane-silent']).toBeUndefined()
    // …and the collector still tailed the file, so this is a refusal to
    // conclude, not a failure to look.
    expect(Object.keys(snapshot.files)).toContainEqual(filePath)
  })

  it('lets a lane\'s freshest transcript speak for it, not its oldest', async () => {
    // A resumed lane has several session files; all but the newest describe a
    // conversation that is over. Only the newest can say anything about now.
    const lane = 'lane-resumed'
    // The fresh session is named FIRST and the stale one LAST, so a reader
    // that picked by filename would get it exactly backwards. Only mtime
    // orders these correctly.
    await plant(lane, PENDING_TOOL, 20_000, { writeAgeMs: 20_000, fileName: 'session-0.jsonl' })
    await plant(lane, TURN_COMPLETE, 3 * 60 * 60_000, {
      writeAgeMs: 3 * 60 * 60_000,
      fileName: 'session-9.jsonl',
    })

    const snapshot = await boot([lane], stubProbe({}))
    expect(snapshot.lanes?.[lane]?.state).toBe('working')
    expect(snapshot.lanes?.[lane]?.shape).toBe('pending-tool')
  })

  it('is deterministic across two identical boots, byte for byte', async () => {
    // Same inputs, same states — the derivation law the replay UI depends on.
    await plant('lane-a', PENDING_TOOL, 30 * 60_000)
    await plant('lane-b', TURN_COMPLETE, 10 * 60_000)
    const lanes = ['lane-a', 'lane-b']
    const table = { [worktreeOf('lane-a')]: true, [worktreeOf('lane-b')]: false }

    const first = await boot(lanes, stubProbe(table))
    const second = await boot(lanes, stubProbe(table))
    expect(JSON.stringify(first.lanes)).toBe(JSON.stringify(second.lanes))
  })

  it('tracks a lane across polls and reports the transition it just made', async () => {
    // WORKING → WAITING as the settle window closes, with nothing appended:
    // the passage of time alone is the whole event, which is exactly the
    // signal a tmuxless setup has never had.
    await plant('lane-a', TURN_COMPLETE, 10_000)
    const collector = createSessionlogCollector({
      claudeProjectsRoot,
      backfill: true,
      processProbe: stubProbe({ [worktreeOf('lane-a')]: true }),
    })
    const exec = tmuxlessExec(['/repo', worktreeOf('lane-a')])

    const first = await collector.poll(collector.initialSnapshot(), makeContext(exec, NOW))
    expect(first.nextSnapshot.lanes?.['lane-a']?.state).toBe('working')
    expect(first.nextSnapshot.lanes?.['lane-a']?.previousState).toBeNull()

    const later = NOW + TURN_SETTLE_MS
    const second = await collector.poll(first.nextSnapshot, makeContext(exec, later))
    const reading = second.nextSnapshot.lanes?.['lane-a'] as LaneLiveness
    expect(reading.state).toBe('waiting')
    expect(reading.previousState).toBe('working')

    // …and the publication step fires exactly once, on the edge.
    const emission = agentStatusEmissionFor({
      handle: 'lane-a',
      worktreePath: worktreeOf('lane-a'),
      branch: 'lane-a',
      previous: reading.previousState,
      reading,
    })
    expect(emission).toMatchObject({ handle: 'lane-a', status: 'waiting' })
  })

  it('emits no new event types — the adapter contract holds', async () => {
    // Ruling 4: the reducer and the UI are untouched per adapter. Whatever
    // this organ learns, the log's vocabulary does not grow.
    await plant('lane-a', TURN_COMPLETE, 20 * 60_000)
    const collector = createSessionlogCollector({
      claudeProjectsRoot,
      backfill: true,
      processProbe: stubProbe({}),
    })
    const result = await collector.poll(
      collector.initialSnapshot(),
      makeContext(tmuxlessExec(['/repo', worktreeOf('lane-a')])),
    )
    const known = new Set(['llm.usage', 'tool.activity', 'collector.error', 'collector.disabled'])
    for (const event of result.events) {
      expect(known, `unexpected event type ${event.type}`).toContain(event.type)
    }
  })

  it('keeps its stall threshold well clear of a real long-running tool call', async () => {
    // p99.9 of 15,804 real tool calls is 205s. A lane four minutes into one
    // must still read as working, or the fleet would cry wolf on every test run.
    await plant('lane-a', PENDING_TOOL, 4 * 60_000)
    const snapshot = await boot(['lane-a'], stubProbe({ [worktreeOf('lane-a')]: true }))
    expect(stateOf(snapshot, 'lane-a')).toBe('working')
    expect(TRANSCRIPT_STALL_MS).toBeGreaterThan(4 * 60_000)
  })
})
