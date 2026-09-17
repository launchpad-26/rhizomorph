import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RhizomorphEvent } from '@rhizomorph/core'
import { BEACON_ATTENTION_KINDS, buildFleet, createCollectorContext, createEvent, reduceAll } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBeaconCollector } from '../collectors/beacon/collector.js'
import { parseBeaconLine } from '../collectors/beacon/parse-beacon-line.js'
import { beaconLineBelongsTo, installationBeaconDir } from '../collectors/beacon/paths.js'
import { canonicalize } from '../paths/containment.js'
import { beaconLineFor, DECLARED_KEYS, MESSAGE_MAX, readStdin, runHookCommand } from './hook.js'

/**
 * `rhizomorph hook` — prd-57 ruling 6.
 *
 * Two properties carry this file, and they are the two the ruling names: it
 * writes a DECLARED key set and nothing else, and it **never blocks the agent**.
 */

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizo-hook-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const FIRING = {
  hook_event_name: 'PreToolUse',
  session_id: '11111111-2222-4333-8444-555555555555',
  transcript_path: '/home/operator/.claude/projects/repo/session.jsonl',
  cwd: '/repo',
  // The field this test exists for: whatever the agent was about to do.
  tool_input: { command: 'git push --force origin main', description: 'MARKER-7f3a1c' },
}

const doorFile = () => path.join(installationBeaconDir(root), 'claude-hook.jsonl')

/**
 * THE WRITER RUN AGAINST THE READER — the test whose absence cost this PRD its
 * most expensive defect, and which the fix for that defect still did not add.
 *
 * `rhizomorph hook` was built in wave 3 and every test of it stopped at the
 * line: the shape was asserted, the parser round-trip was asserted, and nothing
 * ever handed what it wrote to the fold. So `beaconReceived` discarded every
 * one of those lines for months of waves while three suites stayed green — the
 * shape prd-57's closeout names, *an assertion that the input is well-formed
 * standing in for one that something reads it.*
 *
 * Fixing the fold closed it by assertion. This closes it by CONSTRUCTION: the
 * real runner writes the real file, the real parser reads it, the real
 * collector reads it, `reduceAll` folds what that collector emits and
 * `buildFleet` resolves it. The tailing loop is real too — an earlier version of
 * this comment said it was the one thing stubbed, and that stopped being true
 * when the hand-built envelope was replaced by a real `poll()`. What IS
 * injected: the parent pid, the clock, the event ids, and the `process.seen`
 * and `worktree.discovered` facts a live machine would supply. Break any link
 * — stop
 * writing `pid`, discard lane-less lines again, drop the worktree resolution —
 * and this reddens where the shape assertions do not.
 */
describe('the line reaches a lane — writer, parser, fold and fleet, end to end (#589)', () => {
  const AT = Date.UTC(2026, 8, 17, 12, 0, 0)

  /**
   * REAL directories, because the routing rule below canonicalises both sides
   * through `node:fs` and a string literal would make it unanswerable — and
   * because the worktree has to be genuinely INSIDE the repo for the rule to
   * admit the line. The first version of this test used `/repo` and
   * `/repo-wt/2-core`, siblings, which `isInside` rejects: it proved the chain
   * on a fixture the chain drops. Caught in the second review.
   */
  let repoPath: string
  let wt: string

  beforeEach(async () => {
    repoPath = canonicalize(await mkdtemp(path.join(tmpdir(), 'rhizo-e2e-')))
    wt = path.join(repoPath, 'wt', '2-core')
    await mkdir(wt, { recursive: true })
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  let evtId = 0
  function evt(type: Parameters<typeof createEvent>[0], payload: never, ts: number) {
    evtId += 1
    return createEvent(type, payload, { id: `evt-${evtId}`, ts })
  }

  /**
   * THE REAL COLLECTOR, ticked once over the real door.
   *
   * Hand-building the `beacon.received` envelope was the last stub in this
   * chain, and it was load-bearing in a way that only showed up under the
   * question *"would this redden when #597 lands?"* — #597's fix goes in the
   * collector, so a test that skips the collector cannot see it, however
   * carefully it asserts the fold. Third review's finding.
   *
   * So: the runner writes, THIS reads, and whatever it emits is what gets
   * folded. Nothing in between is spelled twice.
   */
  async function collectorEvents(): Promise<readonly RhizomorphEvent[]> {
    const collector = createBeaconCollector({ dataRoot: root })
    let next = 0
    const result = await collector.poll(
      collector.initialSnapshot(),
      createCollectorContext({
        repoPath,
        now: AT,
        exec: async () => {
          throw new Error('the beacon collector must never exec')
        },
        nextId: () => `beacon-${(next += 1)}`,
      }),
    )
    return result.events
  }

  it("a hook firing in a placed actor becomes that lane's declared attention", async () => {
    // 1. THE WRITER. The real runner, the real door, no lane anywhere in sight.
    expect(
      await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'Stop', cwd: wt }), {
        dataRoot: root,
        parentPid: 4321,
        now: () => AT,
      }),
    ).toBe(0)
    const line = (await readFile(doorFile(), 'utf8')).trim()

    // 2. THE PARSER. The collector's own, not a JSON.parse standing in for it.
    const parsed = parseBeaconLine(line)
    expect(parsed.kind).toBe('beacon')
    if (parsed.kind !== 'beacon') return
    // The fact the whole join exists for: the hook has never heard the lane's
    // name, so it writes none.
    expect(parsed.payload.lane).toBeNull()
    expect(parsed.payload.pid).toBe(4321)

    // 3. THE ROUTING RULE, which is not the tailing loop and is the gate that
    // decides whether a hook line reaches any session at all. `rhizomorph hook`
    // writes to the SHARED installation door, so every line it writes is routed
    // by this (ADR-0055). Run for real.
    expect(beaconLineBelongsTo(repoPath, parsed.payload.cwd)).toBe(true)

    // 4. THE FOLD, through the collector's envelope — the three fields it adds
    // around the parsed payload, spelled as `collectors/beacon/collector.ts`
    // spells them.
    const log = [
      evt('session.started', { sessionId: 's1', repoPath, repoName: 'repo' } as never, AT - 900_000),
      evt('worktree.discovered', { path: repoPath, branch: 'main', head: 'sha-0', isMain: true } as never, AT - 900_000),
      evt('worktree.discovered', { path: wt, branch: '2-core', head: 'sha-2', isMain: false } as never, AT - 900_000),
      evt(
        'process.seen',
        { pid: 4321, dialect: 'claude', startedAt: AT - 300_000, worktreePath: wt, placement: 'rooted', parentPid: null } as never,
        AT - 300_000,
      ),
      // Whatever the real collector emits, verbatim. If #597 teaches it to emit
      // an `agent.status` beside the beacon, this picks that up with no edit.
      ...(await collectorEvents()),
    ]

    // 5. THE FLEET. The lane the operator actually looks at.
    const fleet = buildFleet(reduceAll(log), { now: AT + 40_000 })
    const lane = fleet.lanes.find((candidate) => candidate.id === '2-core')
    expect(lane?.declared).toMatchObject({ kind: 'working', joinedBy: 'pid', writer: 'claude-hook' })
  })

  /**
   * AND THE GAP THIS TEST FOUND, pinned so it cannot be closed silently or
   * forgotten quietly — #597.
   *
   * `KIND_BY_EVENT` maps five events to four distinct words, and
   * `BEACON_ATTENTION_KINDS` (`waiting | working | stopped`) holds **two** of
   * them. So `PostToolUse`, `Stop` and `SessionEnd` reach the fold as `working`
   * or `stopped` — and `PreToolUse`'s `tool-running` and **`Notification`'s
   * `waiting-permission` reach nothing at all.** Those two belong to the
   * `agent.status` vocabulary (`events/workmux.ts`), `AGENT_STATUS_SOURCES` has
   * listed `'hook'` as its third source since #529, and **no emitter anywhere
   * produces one.**
   *
   * The third declared word, `waiting`, the hook never writes at all.
   *
   * So the single most valuable hook — `Notification`, the harness saying it
   * has stopped for a human — is written correctly, parsed correctly, and then
   * **discarded before the join is even reached**: `beaconReceived` runs
   * `isAttentionKind` BEFORE `placeByPid`, so this line is never joined to
   * anything. The join was necessary and is not sufficient.
   *
   * This test asserts the CURRENT behaviour, deliberately, and it asserts it at
   * the level the OPERATOR sees rather than at the fold's.
   *
   * The first version of it pinned `state.declared` and `lane.declared`, and
   * promised in three places that it would redden when #597 landed. **It would
   * not have.** If #597 is fixed the way this repo's own vocabulary says — a
   * hook beacon of these kinds emitting an `agent.status` signed `'hook'`,
   * which is what `AGENT_STATUS_SOURCES` has been waiting for since #529 — then
   * `declared` stays `{}` and `declared` stays `null` and the test stays green
   * through the fix. Only the OTHER possible fix, widening
   * `BEACON_ATTENTION_KINDS`, would have reddened it, and prd-57 argues that is
   * the wrong home for those words.
   *
   * Asserting broken behaviour is defensible. Asserting it under a false
   * promise about when it breaks is the same defect as the one being pinned,
   * so the assertion is now the lane's ACTIVITY — which reddens under either
   * route, because either route ends with this lane reading `waiting`.
   */
  it('GAP (#597): a Notification firing reaches no lane — the hook writes a word no fold reads', async () => {
    expect(
      await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'Notification', cwd: wt }), {
        dataRoot: root,
        parentPid: 4321,
        now: () => AT,
      }),
    ).toBe(0)
    const line = (await readFile(doorFile(), 'utf8')).trim()
    const parsed = parseBeaconLine(line)
    expect(parsed.kind).toBe('beacon')
    if (parsed.kind !== 'beacon') return

    // Written, and written correctly — this is not a writer bug.
    expect(parsed.payload.kind).toBe('waiting-permission')
    expect(parsed.payload.pid).toBe(4321)
    // And not one of the three words the fold's declared vocabulary holds.
    expect([...BEACON_ATTENTION_KINDS]).not.toContain(parsed.payload.kind)

    const log = [
      evt('session.started', { sessionId: 's2', repoPath, repoName: 'repo' } as never, AT - 900_000),
      evt('worktree.discovered', { path: repoPath, branch: 'main', head: 'sha-0', isMain: true } as never, AT - 900_000),
      evt('worktree.discovered', { path: wt, branch: '2-core', head: 'sha-2', isMain: false } as never, AT - 900_000),
      evt(
        'process.seen',
        { pid: 4321, dialect: 'claude', startedAt: AT - 300_000, worktreePath: wt, placement: 'rooted', parentPid: null } as never,
        AT - 300_000,
      ),
      // Whatever the real collector emits, verbatim. If #597 teaches it to emit
      // an `agent.status` beside the beacon, this picks that up with no edit.
      ...(await collectorEvents()),
    ]

    const state = reduceAll(log)
    const fleet = buildFleet(state, { now: AT + 40_000 })
    const lane = fleet.lanes.find((candidate) => candidate.id === '2-core')

    // THE OPERATOR-LEVEL FACT, and the one that reddens under either fix: an
    // agent has stopped for a human and this lane does not say so. Both routes
    // to #597 end with `activityOf` reading `waiting` here — one through
    // `lane.declared`, one through `lane.agentStatus`.
    expect(lane?.activity).not.toBe('waiting')
    expect(lane?.pathologies.map((p) => p.kind)).not.toContain('waiting')

    // The fold's own silence, stated beside it so the mechanism is legible —
    // but NOT as the thing the gap is measured by.
    expect(state.declared).toEqual({})
    expect(lane?.declared).toBeNull()
  })
})

describe('what the runner writes, and what it refuses to', () => {
  it('writes ONE line, and the collector can read it back', async () => {
    // Round-tripped through the real parser rather than eyeballed: a line this
    // runner writes that the collector cannot parse is a line that reaches
    // nothing, and shape assertions alone would not catch it.
    expect(await runHookCommand(JSON.stringify(FIRING), { dataRoot: root, parentPid: 4321 })).toBe(0)

    const written = await readFile(doorFile(), 'utf8')
    expect(written.split('\n').filter((l) => l.length > 0)).toHaveLength(1)

    const parsed = parseBeaconLine(written.trim())
    expect(parsed.kind).toBe('beacon')
    if (parsed.kind !== 'beacon') return
    expect(parsed.payload.kind).toBe('tool-running')
    expect(parsed.payload.cwd).toBe('/repo')
    expect(parsed.payload.sessionId).toBe(FIRING.session_id)
    expect(parsed.payload.pid).toBe(4321)
  })

  it('writes NOWHERE else — the whole data root, enumerated', async () => {
    // ADR-0055 grants this runner one write: into the installation's own data
    // root, append only. Asserted by walking the tree rather than by checking
    // the one file exists, because "it wrote the right file" and "it wrote only
    // that file" are different claims and the second is the granted one.
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'SessionEnd' }), { dataRoot: root })

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true })
      const found = await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(dir, entry.name)
          return entry.isDirectory() ? walk(full) : [path.relative(root, full).split(path.sep).join('/')]
        }),
      )
      return found.flat()
    }

    expect(await walk(root)).toEqual(['beacons/claude-hook.jsonl'])
  })

  it('PLANTS tool_input and asserts it is absent from the written bytes', async () => {
    // Ruling 6's own law, and the reason it is about what the RUNNER writes
    // rather than what the boundary strips: ADR-0036 records that the collector
    // keeps whatever the writer said, so a claim that an unknown key "dies at
    // the boundary" would be false. The file keeps what is written — therefore
    // the words must never be written.
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })

    const written = await readFile(doorFile(), 'utf8')
    expect(written).not.toContain('MARKER-7f3a1c')
    expect(written).not.toContain('tool_input')
    expect(written).not.toContain('git push')
    // The control: the marker really was in the input, and a line really was
    // written. Missing either makes the absence meaningless.
    expect(JSON.stringify(FIRING)).toContain('MARKER-7f3a1c')
    expect(written.length).toBeGreaterThan(0)
  })

  it('writes only the declared keys — asserted against the key set, not a sample', async () => {
    await runHookCommand(JSON.stringify({ ...FIRING, message: 'hi', extra: 'nope', nested: { a: 1 } }), {
      dataRoot: root,
    })
    const line = JSON.parse((await readFile(doorFile(), 'utf8')).trim()) as Record<string, unknown>

    for (const key of Object.keys(line)) {
      expect(DECLARED_KEYS, `the runner wrote an undeclared key: ${key}`).toContain(key)
    }
    expect(line.extra).toBeUndefined()
    expect(line.nested).toBeUndefined()
  })

  it('bounds the one field that carries an agent’s words', async () => {
    // A permission prompt's own sentence is admitted; it is bounded by the
    // WRITER rather than by whoever reads it, so an over-long one cannot reach
    // disk at all.
    const long = 'x'.repeat(MESSAGE_MAX * 3)
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'Notification', message: long }), {
      dataRoot: root,
    })
    const line = JSON.parse((await readFile(doorFile(), 'utf8')).trim()) as { message: string }
    expect(line.message).toHaveLength(MESSAGE_MAX)
  })

  it('maps each lifecycle event to the word ruling 5 derives from it', () => {
    const kindFor = (hook_event_name: string) => {
      const line = beaconLineFor({ ...FIRING, hook_event_name }, { parentPid: 1 })
      return line === null ? null : (JSON.parse(line) as { kind: string }).kind
    }
    expect(kindFor('PreToolUse')).toBe('tool-running')
    expect(kindFor('PostToolUse')).toBe('working')
    expect(kindFor('Notification')).toBe('waiting-permission')
    expect(kindFor('Stop')).toBe('working')
    expect(kindFor('SessionEnd')).toBe('stopped')
  })

  it('writes NOTHING for an event it has no word for — never a guessed state', async () => {
    // A hook entry an operator added by hand, or one a future harness fires.
    // Inventing a word for it would widen ruling 5's vocabulary without a ruling.
    expect(beaconLineFor({ ...FIRING, hook_event_name: 'SubagentStop' })).toBeNull()
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'SubagentStop' }), { dataRoot: root })
    await expect(readdir(installationBeaconDir(root))).rejects.toThrow()
  })
})

describe('THE LAW: it never blocks the agent', () => {
  it('gives up on a stdin that never closes, rather than waiting forever', async () => {
    // The worst version of blocking the agent, and the one an exit code cannot
    // express: a harness that spawns the runner and does not close the pipe.
    // An unbounded read hangs here and the tool call hangs with it.
    const { Readable } = await import('node:stream')
    const openForever = new Readable({ read() {} })
    openForever.push('{"hook_event_name":"Stop"')

    const started = Date.now()
    const text = await readStdin(openForever, 40)

    expect(Date.now() - started).toBeLessThan(2000)
    // What arrived before the deadline is handed back, not discarded — and a
    // half-line is declined by the parse, which is the same quiet nothing.
    expect(text).toBe('{"hook_event_name":"Stop"')
    expect(await runHookCommand(text, { dataRoot: root })).toBe(0)
    await expect(readdir(installationBeaconDir(root))).rejects.toThrow()
    openForever.destroy()
  })

  it('a stdin that DOES close is read whole — the bound is a ceiling, not a truncation', async () => {
    // The control. Without it, "it gave up" would also pass a runner that read
    // nothing at all.
    const { Readable } = await import('node:stream')
    const payload = JSON.stringify(FIRING)

    expect(await readStdin(Readable.from([payload]), 40)).toBe(payload)
  })

  /**
   * Every one of these is a real failure and every one exits 0. A hook that
   * exits non-zero can make the harness surface an error, retry, or refuse the
   * tool call — so a broken instrument would degrade the thing it exists to
   * watch. The operator learns from `doctor`; their agent must never learn at
   * all.
   */
  it.each([
    ['stdin that is not JSON', 'not json at all'],
    ['stdin that is JSON but not an object', '[1,2,3]'],
    ['an empty payload', '{}'],
    ['a payload with no hook_event_name', JSON.stringify({ cwd: '/repo' })],
    ['a null payload', 'null'],
    ['empty stdin', ''],
  ])('exits 0 on %s', async (_label, stdin) => {
    expect(await runHookCommand(stdin, { dataRoot: root })).toBe(0)
  })

  it('exits 0 when the door cannot be created at all', async () => {
    // A data root that cannot hold a directory — the stand-in for a full disk,
    // a permission refusal, or a read-only volume. The runner must not care
    // which.
    const notADirectory = path.join(root, 'file.txt')
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(notADirectory, 'x', 'utf8')

    expect(await runHookCommand(JSON.stringify(FIRING), { dataRoot: notADirectory })).toBe(0)
  })

  it('exits 0 even for a firing it wrote successfully — there is no other answer', async () => {
    // The control that makes the cases above mean something: this returns 0 on
    // success too, so "0" is not evidence of failure being swallowed. The
    // evidence is the file, which the tests above read.
    expect(await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })).toBe(0)
    expect((await readFile(doorFile(), 'utf8')).length).toBeGreaterThan(0)
  })

  it('appends rather than truncating — two firings are two lines', async () => {
    await runHookCommand(JSON.stringify(FIRING), { dataRoot: root })
    await runHookCommand(JSON.stringify({ ...FIRING, hook_event_name: 'Stop' }), { dataRoot: root })

    const lines = (await readFile(doorFile(), 'utf8')).split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).kind).toBe('tool-running')
    expect(JSON.parse(lines[1]!).kind).toBe('working')
  })
})
