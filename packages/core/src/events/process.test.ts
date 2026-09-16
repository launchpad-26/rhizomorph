import { describe, expect, it } from 'vitest'
import { createEvent, parseEvent } from './index.js'
import {
  processActivityPayloadSchema,
  processGonePayloadSchema,
  processSeenPayloadSchema,
} from './process.js'
import { initialSessionState, reduce } from '../index.js'
import { actorKey } from '../reduce.js'

/**
 * The process families' key-sets, and the one guarantee ADR-0052 makes that a
 * schema can actually hold: **nothing here can carry a command line.**
 */

const SEEN = {
  pid: 4321,
  dialect: 'claude',
  startedAt: 1788591360000,
  worktreePath: '/repo-wt/2-core',
  placement: 'rooted',
  parentPid: null,
} as const

describe('the three payloads are closed, in the shape this repo actually uses', () => {
  it('process.seen has a fixed key-set', () => {
    expect(Object.keys(processSeenPayloadSchema.shape).sort()).toEqual([
      'dialect',
      'parentPid',
      'pid',
      'placement',
      'startedAt',
      'worktreePath',
    ])
  })

  it('process.activity has a fixed key-set', () => {
    expect(Object.keys(processActivityPayloadSchema.shape).sort()).toEqual([
      'cpuMsDelta',
      'pid',
      'rssBytes',
      'startedAt',
    ])
  })

  it('process.gone has a fixed key-set', () => {
    expect(Object.keys(processGonePayloadSchema.shape).sort()).toEqual(['pid', 'reason', 'startedAt'])
  })

  it('strips an unknown key rather than failing the line — ADR-0011, not `.strict()`', () => {
    // `.strict()` appears nowhere in this repo, and deliberately: a refusing
    // parse rots a log that must fold recordings from older eras. The closure
    // here is the key-set assertions above plus `no-open-payload-law`, which
    // sweeps this directory by glob and needs no edit to reach this file.
    const parsed = processSeenPayloadSchema.parse({ ...SEEN, somethingLater: 1 })
    expect(Object.keys(parsed)).not.toContain('somethingLater')
  })
})

describe('no field here can carry a command line (ADR-0052, Success 2)', () => {
  /**
   * The strongest form wave 1 can prove. A planted marker travelling through a
   * real collector is wave 2's test, because wave 1 ships no collector — and a
   * test that claimed to prove it now would be asserting over an emitter that
   * does not exist, which is the vacuous shape this repo names.
   *
   * What IS provable here, and is the thing that actually holds the guarantee:
   * the schema has no field a command line could occupy, so no collector can
   * ever emit one without first widening this file — where the key-set
   * assertions above turn red.
   */
  it('names no field for argv, a command line, or an environment', () => {
    const everyKey = [
      ...Object.keys(processSeenPayloadSchema.shape),
      ...Object.keys(processActivityPayloadSchema.shape),
      ...Object.keys(processGonePayloadSchema.shape),
    ]
    for (const forbidden of ['argv', 'cmdline', 'commandLine', 'command', 'args', 'env', 'environ', 'environment']) {
      expect(everyKey, `a process payload names ${forbidden}`).not.toContain(forbidden)
    }
  })

  /**
   * The marker is PLANTED here, which the first version of this test did not do.
   *
   * Review of #553, B3: it declared `MARKER-e6f1a2`, built an event that never
   * contained it, and asserted the marker was absent — a constant compared
   * against text that never had a chance to carry it. #516 asked for this test
   * and named this exact trap: *"break the argv filter deliberately and show
   * the marker test going red for the reason it claims."*
   *
   * Planting it turned up B2 in the same breath — `worktreePath` had no ceiling,
   * so a whole command line parsed and rode into the serialised event. So the
   * honest version is three claims rather than one, because three different
   * mechanisms do the work and **one of them is not in this package at all**.
   */
  describe('a planted marker, and what actually stops it', () => {
    const MARKER = 'MARKER-e6f1a2'
    const COMMAND_LINE = `claude -p "rewrite the deploy key ${MARKER}" --model opus`

    it('1. a key this schema does not name is DROPPED by the parse — argv cannot ride under its own name', () => {
      // The structural guarantee the docblock claims, and the one that holds
      // without qualification. zod strips unknown keys (ADR-0011's lenient
      // read, never `.strict()`) and `createEvent` parses, so a collector
      // cannot smuggle a command line through by inventing a field for it.
      const event = createEvent(
        'process.seen',
        { ...SEEN, argv: [COMMAND_LINE], cmdline: COMMAND_LINE } as never,
        { id: 'evt-1', ts: 1 },
      )

      expect(JSON.stringify(event)).not.toContain(MARKER)
      expect(event.payload).not.toHaveProperty('argv')
      // The controls that make an absence mean something: the marker really was
      // in the input, and the event really was built. Missing either is how the
      // first version of this test passed while asserting nothing.
      expect(COMMAND_LINE).toContain(MARKER)
      expect(event.type).toBe('process.seen')
      expect(event.payload.pid).toBe(4321)
    })

    it('2. an UNBOUNDED one is refused by both ceilings — nothing rides through by volume', () => {
      const long = `${COMMAND_LINE} ${'x'.repeat(4096)}`
      expect(() => createEvent('process.seen', { ...SEEN, worktreePath: long }, { id: 'evt-2', ts: 2 })).toThrow()
      expect(() => createEvent('process.seen', { ...SEEN, dialect: long }, { id: 'evt-3', ts: 3 })).toThrow()
    })

    it('3. but a SHORT one fits BOTH string fields, and the schema is not what stops it', () => {
      // Stated rather than papered over, and it is not only `worktreePath`:
      // this command line is 61 characters, so it is under `dialect`'s ceiling
      // of 64 as well. Found by writing this assertion — the first draft
      // expected `dialect` to refuse it, and it did not.
      //
      // So "both fields are bounded facts, and neither is free text a marker
      // could ride in" — the comment that stood here before the review — is
      // false for both of them. A bound stops volume, never shape.
      //
      // What actually keeps a command line out of these two fields is upstream
      // and not in this package: `worktreePath` gets a canonicalised cwd from
      // the collector (prd-57 ruling 3), and `dialect` gets a member of the
      // probe's `AGENT_COMMANDS` roster, which is a closed list rather than
      // anything read off the process. Both belong to the collector, and
      // NEITHER IS TESTED ANYWHERE YET — wave 1 ships no collector, so
      // `packages/server/src/collectors/process/` holds one law and no source.
      // Wave 2 is where those two obligations get a test; until it lands, the
      // only thing standing between argv and an event is claim 1 above.
      //
      // Said in that many words on purpose (review of #553, round 2): the
      // sentence here read "both are tested where they are decided, in
      // `collectors/process/collector.test.ts`" — present tense, naming a file
      // that does not exist. That is the shape B2 was, one layer out, and the
      // citation law could not see it because the path was not repo-rooted.
      //
      // This assertion exists so that limit is visible AT the schema rather
      // than discovered later by someone trusting the docblock above it.
      expect(COMMAND_LINE.length).toBeLessThan(64)

      const inPath = createEvent('process.seen', { ...SEEN, worktreePath: COMMAND_LINE }, { id: 'evt-4', ts: 4 })
      expect(inPath.payload.worktreePath).toBe(COMMAND_LINE)
      expect(JSON.stringify(inPath)).toContain(MARKER)

      const inDialect = createEvent('process.seen', { ...SEEN, dialect: COMMAND_LINE }, { id: 'evt-5', ts: 5 })
      expect(inDialect.payload.dialect).toBe(COMMAND_LINE)
    })
  })
})

describe('an actor is a RUN, not a pid', () => {
  it('a recycled pid is a different actor — gone, then a new seen', () => {
    let state = initialSessionState()
    state = reduce(state, createEvent('process.seen', SEEN, { id: 'e1', ts: 10 }))
    state = reduce(
      state,
      createEvent('process.gone', { pid: 4321, startedAt: SEEN.startedAt, reason: 'recycled' }, { id: 'e2', ts: 20 }),
    )
    // Same pid, later start time: a different run, and therefore a different
    // actor rather than the old one coming back.
    const reborn = { ...SEEN, startedAt: SEEN.startedAt + 5000 }
    state = reduce(state, createEvent('process.seen', reborn, { id: 'e3', ts: 30 }))

    expect(Object.keys(state.processes).sort()).toEqual(
      [actorKey(4321, SEEN.startedAt), actorKey(4321, reborn.startedAt)].sort(),
    )
    expect(state.processes[actorKey(4321, SEEN.startedAt)]?.goneAt).toBe(20)
    expect(state.processes[actorKey(4321, reborn.startedAt)]?.goneAt).toBeNull()
  })

  it('a gone actor is KEPT, never deleted — crashed is reached from the seen/gone pair', () => {
    // prd-57 ruling 5 reaches `crashed` from a `gone` that follows a `seen`. A
    // fold that dropped the row would destroy the first half of that pair, and
    // wave 4's raiser would have nothing to edge-trigger against.
    let state = initialSessionState()
    state = reduce(state, createEvent('process.seen', SEEN, { id: 'e1', ts: 10 }))
    state = reduce(
      state,
      createEvent('process.gone', { pid: 4321, startedAt: SEEN.startedAt, reason: 'absent' }, { id: 'e2', ts: 20 }),
    )
    const actor = state.processes[actorKey(4321, SEEN.startedAt)]
    expect(actor).toBeDefined()
    expect(actor?.seenAt).toBe(10)
    expect(actor?.goneAt).toBe(20)
    expect(actor?.goneReason).toBe('absent')
  })

  it('a repeated seen keeps activity already reported — the poll path is at-least-once (ADR-0029)', () => {
    let state = initialSessionState()
    state = reduce(state, createEvent('process.seen', SEEN, { id: 'e1', ts: 10 }))
    state = reduce(
      state,
      createEvent(
        'process.activity',
        { pid: 4321, startedAt: SEEN.startedAt, cpuMsDelta: 900, rssBytes: 1024 },
        { id: 'e2', ts: 20 },
      ),
    )
    state = reduce(state, createEvent('process.seen', SEEN, { id: 'e3', ts: 30 }))

    const actor = state.processes[actorKey(4321, SEEN.startedAt)]
    expect(actor?.cpuMsDelta).toBe(900)
    expect(actor?.seenAt).toBe(10)
  })

  it('activity for an actor never seen is dropped, not invented', () => {
    // A fold that materialised one would be claiming a placement and a dialect
    // nobody told it, and `buildFleet` would then place a lane on that
    // invention.
    const state = reduce(
      initialSessionState(),
      createEvent(
        'process.activity',
        { pid: 9999, startedAt: 1, cpuMsDelta: 1, rssBytes: 1 },
        { id: 'e1', ts: 10 },
      ),
    )
    expect(state.processes).toEqual({})
  })
})

describe('placement says how sure the witness is', () => {
  it.each(['rooted', 'unrooted', 'unknown'])('accepts %s', (placement) => {
    expect(() => processSeenPayloadSchema.parse({ ...SEEN, placement })).not.toThrow()
  })

  it('an unrooted actor carries a null worktree rather than a guessed one', () => {
    const parsed = processSeenPayloadSchema.parse({ ...SEEN, worktreePath: null, placement: 'unrooted' })
    expect(parsed.worktreePath).toBeNull()
  })

  it('refuses a placement nobody declared', () => {
    expect(() => processSeenPayloadSchema.parse({ ...SEEN, placement: 'probably' })).toThrow()
  })

  it('parentPid is nullable — parentage is recorded only among matched actors', () => {
    expect(processSeenPayloadSchema.parse({ ...SEEN, parentPid: null }).parentPid).toBeNull()
    expect(processSeenPayloadSchema.parse({ ...SEEN, parentPid: 4000 }).parentPid).toBe(4000)
  })
})

describe('the envelope', () => {
  it.each(['process.seen', 'process.activity', 'process.gone'])('%s is sourced `process` and parses', (type) => {
    const payload =
      type === 'process.seen'
        ? SEEN
        : type === 'process.activity'
          ? { pid: 4321, startedAt: SEEN.startedAt, cpuMsDelta: 1, rssBytes: 2 }
          : { pid: 4321, startedAt: SEEN.startedAt, reason: 'absent' as const }
    const event = createEvent(type as 'process.seen', payload as never, { id: 'evt-1', ts: 1 })
    expect(event.source).toBe('process')
    expect(parseEvent(event).ok).toBe(true)
  })

  it('refuses an event claiming a different source — the envelope may not lie (ADR-0009)', () => {
    expect(
      parseEvent({ id: 'evt-1', ts: 1, source: 'git', type: 'process.seen', payload: SEEN }).ok,
    ).toBe(false)
  })
})
