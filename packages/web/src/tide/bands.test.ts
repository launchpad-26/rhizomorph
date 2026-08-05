import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { IDLE_AFTER_MS } from '../fleet/buildFleet.js'
import { BAND_STATES, bandsFor, laneOf, totalDurationMs, type Band, type LaneBands } from './bands.js'
import { TIDE_START_TS, generateEventLog } from './fixtures.js'

const T0 = TIDE_START_TS
const MINUTE = 60_000

/** Seeds, not a clock: a failure here is reproducible from the number alone. */
const SEEDS = [1, 7, 42, 1_337, 90_210]

// ── the law's own vocabulary, restated here rather than imported ─────────────
// A test that imported the module's own tables would be checking them against
// themselves. These four types are the set `buildFleet`'s `lastWorkTs` folds.

const WORK_WITNESSES = new Set(['llm.usage', 'llm.cost', 'tool.activity', 'trace.span'])

interface Attestation {
  ts: number
  state: string
  declared: boolean
}

function attestationsFor(events: readonly RhizomorphEvent[], lane: string): Attestation[] {
  const found: Attestation[] = []
  for (const event of events) {
    if (laneOf(event) !== lane) continue
    if (event.type === 'agent.status') {
      found.push({ ts: event.ts, state: event.payload.status, declared: true })
    } else if (WORK_WITNESSES.has(event.type)) {
      found.push({ ts: event.ts, state: 'working', declared: false })
    }
  }
  return found
}

function laneEventTimes(events: readonly RhizomorphEvent[], lane: string): number[] {
  return events.filter((event) => laneOf(event) === lane).map((event) => event.ts)
}

// ── fixtures ────────────────────────────────────────────────────────────────

function log(build: (fx: ReturnType<typeof createEventFactory>) => void): RhizomorphEvent[] {
  const fx = createEventFactory({ startTs: T0, stepMs: 0 })
  build(fx)
  return fx.all()
}

function only(lanes: readonly LaneBands[], lane: string): LaneBands {
  const found = lanes.find((entry) => entry.lane === lane)
  if (found === undefined) throw new Error(`no bands for lane ${lane}`)
  return found
}

// ── the shape the TIDE renders ──────────────────────────────────────────────

describe('bandsFor — the story the issue tells', () => {
  it('reads ke5 as WORKING 14:00–14:38, then WAITING from 14:38', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + 38 * MINUTE).agentStatus({ handle: 'ke5', status: 'waiting' })
      fx.at(T0 + 52 * MINUTE).agentStatus({ handle: 'ke5', status: 'waiting' })
    })

    expect(only(bandsFor(events), 'ke5').bands).toEqual([
      {
        kind: 'state',
        lane: 'ke5',
        state: 'working',
        startTs: T0,
        endTs: T0 + 38 * MINUTE,
        durationMs: 38 * MINUTE,
      },
      {
        kind: 'state',
        lane: 'ke5',
        state: 'waiting',
        startTs: T0 + 38 * MINUTE,
        // Still in force at the log's edge: open, not closed at 14:52.
        endTs: null,
        durationMs: 14 * MINUTE,
      },
    ])
  })

  it('holds a declaration until the next one — a repeat is not a new band', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + 10 * MINUTE).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + 20 * MINUTE).agentStatus({ handle: 'ke5', status: 'working' })
    })

    const bands = only(bandsFor(events), 'ke5').bands
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ state: 'working', startTs: T0, endTs: null })
  })

  it('emits one open band, of zero observed duration, for a lane seen exactly once', () => {
    const events = log((fx) => {
      fx.at(T0).llmUsage({ lane: 'ke5' })
    })

    expect(only(bandsFor(events), 'ke5').bands).toEqual([
      { kind: 'state', lane: 'ke5', state: 'working', startTs: T0, endTs: null, durationMs: 0 },
    ])
  })
})

// ── gaps are absence, not a state (prd13 ruling 8) ───────────────────────────

describe('bandsFor — a gap is absence, and absence has its own type', () => {
  it('lapses into a gap at the instant coverage stopped, not at the event that noticed', () => {
    const events = log((fx) => {
      fx.at(T0).toolActivity({ lane: 'ke5' })
      fx.at(T0 + 30 * MINUTE).toolActivity({ lane: 'ke5' })
    })

    const bands = only(bandsFor(events), 'ke5').bands
    expect(bands).toEqual([
      {
        kind: 'state',
        lane: 'ke5',
        state: 'working',
        startTs: T0,
        endTs: T0 + IDLE_AFTER_MS,
        durationMs: IDLE_AFTER_MS,
      },
      {
        kind: 'gap',
        lane: 'ke5',
        startTs: T0 + IDLE_AFTER_MS,
        endTs: T0 + 30 * MINUTE,
        durationMs: 30 * MINUTE - IDLE_AFTER_MS,
      },
      {
        kind: 'state',
        lane: 'ke5',
        state: 'working',
        startTs: T0 + 30 * MINUTE,
        endTs: null,
        durationMs: 0,
      },
    ])
  })

  it('gives a gap no state to read — the discriminant, not a convention', () => {
    const events = log((fx) => {
      fx.at(T0).toolActivity({ lane: 'ke5' })
      fx.at(T0 + 30 * MINUTE).toolActivity({ lane: 'ke5' })
    })

    const gap = only(bandsFor(events), 'ke5').bands.find((band) => band.kind === 'gap') as Band
    expect(gap.kind).toBe('gap')
    expect('state' in gap).toBe(false)
  })

  it('an uninstrumented lane is unknown for its whole span, never idle', () => {
    // `agent.activeTime` is a metrics POST on a timer: it proves the lane
    // exists and attests not one moment of work.
    const events = log((fx) => {
      fx.at(T0).agentActiveTime({ lane: 'q9' })
      fx.at(T0 + 5 * MINUTE).agentActiveTime({ lane: 'q9' })
      fx.at(T0 + 40 * MINUTE).agentActiveTime({ lane: 'q9' })
    })

    const bands = only(bandsFor(events), 'q9').bands
    expect(bands).toEqual([
      { kind: 'gap', lane: 'q9', startTs: T0, endTs: null, durationMs: 40 * MINUTE },
    ])
    expect(bands.every((band) => band.kind === 'gap')).toBe(true)
  })

  it('never emits a state the ladder derives from a clock — no idle, no unknown', () => {
    for (const seed of SEEDS) {
      for (const lane of bandsFor(generateEventLog(seed, 200))) {
        for (const band of lane.bands) {
          if (band.kind === 'state') expect(BAND_STATES).toContain(band.state)
        }
      }
    }
  })

  it('no state band covers an instant no event attested', () => {
    for (const seed of SEEDS) {
      const events = generateEventLog(seed, 200)
      for (const lane of bandsFor(events)) {
        const attestations = attestationsFor(events, lane.lane)
        for (const band of lane.bands) {
          if (band.kind !== 'state') continue

          // Every state band opens on an event that attested exactly that state…
          expect(
            attestations.some((a) => a.ts === band.startTs && a.state === band.state),
          ).toBe(true)

          // …and ends within reach of the last attestation inside it: either a
          // standing declaration, or one witness-horizon past the last witness.
          const end = band.endTs ?? lane.lastSeenTs
          // A closed band ends *at* the fact that ended it, which belongs to
          // the next band; an open one owns everything up to the log's edge.
          const inside = attestations.filter(
            (a) => a.ts >= band.startTs && (a.ts < end || band.endTs === null),
          )
          const declared = inside.some((a) => a.declared && a.state === band.state)
          const lastWitness = Math.max(...inside.map((a) => a.ts))
          expect(declared || end <= lastWitness + IDLE_AFTER_MS).toBe(true)
        }
      }
    }
  })

  it('no gap band covers an instant an event did attest', () => {
    for (const seed of SEEDS) {
      const events = generateEventLog(seed, 200)
      for (const lane of bandsFor(events)) {
        const attestations = attestationsFor(events, lane.lane)
        for (const band of lane.bands) {
          if (band.kind !== 'gap') continue
          const end = band.endTs ?? lane.lastSeenTs
          const swallowed = attestations.filter((a) => a.ts >= band.startTs && a.ts <= end)
          // A gap may end *at* the event that ends it; it may not contain one.
          expect(swallowed.every((a) => a.ts === end && band.endTs !== null)).toBe(true)
        }
      }
    }
  })
})

// ── precedence: one mapping, in one place ───────────────────────────────────

describe('bandsFor — whose word counts', () => {
  it('lets a standing declaration outrank a work witness, as activityOf does', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'waiting' })
      fx.at(T0 + MINUTE).toolActivity({ lane: 'ke5' })
      fx.at(T0 + 2 * MINUTE).llmUsage({ lane: 'ke5' })
    })

    const bands = only(bandsFor(events), 'ke5').bands
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ state: 'waiting', startTs: T0, endTs: null })
  })

  it('takes a fresh declaration over the state a witness had inferred', () => {
    const events = log((fx) => {
      fx.at(T0).llmUsage({ lane: 'ke5' })
      fx.at(T0 + MINUTE).agentStatus({ handle: 'ke5', status: 'waiting' })
    })

    expect(only(bandsFor(events), 'ke5').bands).toEqual([
      {
        kind: 'state',
        lane: 'ke5',
        state: 'working',
        startTs: T0,
        endTs: T0 + MINUTE,
        durationMs: MINUTE,
      },
      {
        kind: 'state',
        lane: 'ke5',
        state: 'waiting',
        startTs: T0 + MINUTE,
        endTs: null,
        durationMs: 0,
      },
    ])
  })

  it('gives a declaration no horizon: it stands however long the lane is quiet', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'done' })
      fx.at(T0 + 10 * IDLE_AFTER_MS).agentActiveTime({ lane: 'ke5' })
    })

    const bands = only(bandsFor(events), 'ke5').bands
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ state: 'done', durationMs: 10 * IDLE_AFTER_MS })
  })
})

// ── keying: only self-attributing events make a lane ────────────────────────

describe('bandsFor — what counts as naming a lane', () => {
  it('ignores facts keyed by branch, path or pane — resolving those is buildFleet’s job', () => {
    const events = log((fx) => {
      fx.at(T0).paneActivity()
      fx.at(T0 + MINUTE).commitLanded()
      fx.at(T0 + 2 * MINUTE).worktreeDirty()
    })

    expect(bandsFor(events)).toEqual([])
  })

  it('files workmux’s handle and the money layer’s lane under one row', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + MINUTE).llmUsage({ lane: 'ke5' })
    })

    expect(bandsFor(events)).toHaveLength(1)
  })

  it('orders lanes by first sighting, then by handle — never by size or rank', () => {
    const events = log((fx) => {
      fx.at(T0 + MINUTE).llmUsage({ lane: 'zz' })
      fx.at(T0).llmUsage({ lane: 'ke5' })
      fx.at(T0 + MINUTE).llmUsage({ lane: 'aa' })
    })

    expect(bandsFor(events).map((lane) => lane.lane)).toEqual(['ke5', 'aa', 'zz'])
  })
})

// ── the tiling law ──────────────────────────────────────────────────────────

describe('bandsFor — contiguous, non-overlapping, and summing to the span', () => {
  const assertTiling = (lanes: readonly LaneBands[]): void => {
    for (const lane of lanes) {
      const bands = lane.bands
      expect(bands.length).toBeGreaterThan(0)
      expect(bands[0]?.startTs).toBe(lane.firstSeenTs)
      expect(bands.at(-1)?.endTs).toBe(null)

      for (let i = 0; i < bands.length; i += 1) {
        const band = bands[i] as Band
        const end = band.endTs ?? lane.lastSeenTs
        expect(end).toBeGreaterThanOrEqual(band.startTs)
        expect(band.durationMs).toBe(end - band.startTs)
        // Only the open band may have nothing to cover; a closed one is a band.
        if (band.endTs !== null) expect(band.durationMs).toBeGreaterThan(0)
        const next = bands[i + 1]
        if (next !== undefined) expect(next.startTs).toBe(band.endTs)
      }

      expect(totalDurationMs(bands)).toBe(lane.lastSeenTs - lane.firstSeenTs)
    }
  }

  it('tiles every generated lane exactly', () => {
    for (const seed of SEEDS) assertTiling(bandsFor(generateEventLog(seed, 200)))
  })

  it('tiles even when the log arrives out of order — time never rewinds', () => {
    const events = generateEventLog(11, 120)
    const shuffled = [...events].reverse()
    const lanes = bandsFor(shuffled)
    assertTiling(lanes)
    for (const lane of lanes) expect(lane.lastSeenTs).toBeGreaterThanOrEqual(lane.firstSeenTs)
  })
})

// ── same selector, live and replay ──────────────────────────────────────────

/** The whole log's bands as they stood at `t` — the truncation the law names. */
function truncateAt(bands: readonly Band[], t: number): Band[] {
  const out: Band[] = []
  for (const band of bands) {
    if (band.endTs !== null && band.endTs <= t) {
      out.push(band)
      continue
    }
    out.push(
      band.kind === 'gap'
        ? { ...band, endTs: null, durationMs: t - band.startTs }
        : { ...band, endTs: null, durationMs: t - band.startTs },
    )
    break
  }
  return out
}

describe('bandsFor — the product’s core law: one selector, live and replay', () => {
  it('over any time-prefix equals the whole log’s bands truncated at that instant', () => {
    for (const seed of SEEDS) {
      const events = generateEventLog(seed, 160)
      const whole = bandsFor(events)
      const cuts = [...new Set(events.map((event) => event.ts))]

      for (const cut of cuts) {
        const prefix = events.filter((event) => event.ts <= cut)
        const expected = whole
          .map((lane) => {
            const times = laneEventTimes(prefix, lane.lane)
            if (times.length === 0) return null
            const lastSeenTs = Math.max(...times)
            return {
              lane: lane.lane,
              firstSeenTs: lane.firstSeenTs,
              lastSeenTs,
              bands: truncateAt(lane.bands, lastSeenTs),
            }
          })
          .filter((entry) => entry !== null)

        expect(bandsFor(prefix)).toEqual(expected)
      }
    }
  })

  it('never revises a closed band as more events arrive', () => {
    for (const seed of SEEDS) {
      const events = generateEventLog(seed, 120)
      const whole = bandsFor(events)

      for (let cut = 1; cut <= events.length; cut += 7) {
        for (const lane of bandsFor(events.slice(0, cut))) {
          const closed = lane.bands.filter((band) => band.endTs !== null)
          const wholeClosed = only(whole, lane.lane).bands.filter((band) => band.endTs !== null)
          expect(wholeClosed.slice(0, closed.length)).toEqual(closed)
        }
      }
    }
  })
})

// ── determinism ─────────────────────────────────────────────────────────────

describe('bandsFor — determinism', () => {
  it('returns byte-equal bands for the same events, every time', () => {
    for (const seed of SEEDS) {
      const events = generateEventLog(seed, 200)
      const once = JSON.stringify(bandsFor(events))
      const twice = JSON.stringify(bandsFor(events))
      const rebuilt = JSON.stringify(bandsFor(generateEventLog(seed, 200)))
      expect(twice).toBe(once)
      expect(rebuilt).toBe(once)
    }
  })

  it('reads no clock: an empty log has no lanes and no opinions', () => {
    expect(bandsFor([])).toEqual([])
  })
})
