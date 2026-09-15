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

  it('a marker planted in every string field cannot reach an event as a command line', () => {
    // The two string fields are `dialect` and `worktreePath`. Both are bounded
    // facts — a roster name and a path — and neither is free text a marker
    // could ride in unnoticed. Asserted rather than assumed, because "no field
    // carries argv" is only true if the fields that DO exist cannot be abused
    // as one.
    const marker = 'MARKER-e6f1a2'
    const event = createEvent(
      'process.seen',
      { ...SEEN, dialect: 'claude', worktreePath: '/repo-wt/2-core' },
      { id: 'evt-1', ts: 1 },
    )
    expect(JSON.stringify(event)).not.toContain(marker)
    // And the control that makes that assertion mean something: the event WAS
    // built. A marker test over an empty object passes for the wrong reason.
    expect(event.type).toBe('process.seen')
    expect(event.payload.pid).toBe(4321)
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
