import { describe, expect, it } from 'vitest'
import {
  agentStatusEmissionFor,
  deriveLaneState,
  needsProcessProbe,
  TRANSCRIPT_STALL_MS,
  TURN_SETTLE_MS,
  type LaneState,
  type LaneStateInputs,
} from './lane-state.js'
import type { TurnShape } from './turn-shape.js'

const NOW = 1_800_000_000_000
const ALL_SHAPES: TurnShape[] = ['empty', 'turn-complete', 'pending-tool', 'mid-stream', 'awaiting-reply']
const MID_TURN_SHAPES: TurnShape[] = ['pending-tool', 'mid-stream', 'awaiting-reply']

function inputs(overrides: Partial<LaneStateInputs> = {}): LaneStateInputs {
  return {
    now: NOW,
    shape: 'turn-complete',
    lastEntryTs: NOW,
    lastWriteTs: NOW,
    processAlive: null,
    ...overrides,
  }
}

function stateOf(overrides: Partial<LaneStateInputs> = {}): LaneState | null {
  return deriveLaneState(inputs(overrides))?.state ?? null
}

describe('the thresholds are restated from the tmux collector, and named', () => {
  it('keeps buildFleet\'s proven constants rather than inventing new ones', () => {
    // prd15 ruling 1: "thresholds start from the tmux collector's proven
    // constants". WAITING_QUIET_MS (75s) and FROZEN_AFTER_MS (8m) are those
    // constants; this organ restates them against its own corpus rather than
    // importing them across a package boundary the fence does not cross.
    expect(TURN_SETTLE_MS).toBe(75_000)
    expect(TRANSCRIPT_STALL_MS).toBe(8 * 60_000)
    // An unfinished turn is given far longer than a finished one: a tool can
    // legitimately run for minutes (p99.9 = 205s in the corpus); a completed
    // turn has nothing left to run.
    expect(TRANSCRIPT_STALL_MS).toBeGreaterThan(TURN_SETTLE_MS)
  })
})

describe('WORKING — the transcript is in motion', () => {
  it('reads a moving mid-turn transcript as working, whatever the shape', () => {
    for (const shape of MID_TURN_SHAPES) {
      expect(stateOf({ shape, lastEntryTs: NOW - 30_000 }), shape).toBe('working')
    }
  })

  it('gives a just-completed turn its settle window before summoning', () => {
    // 103 of the 150 completed turns in the corpus that resumed did so inside
    // 75s (median 11.2s) — autocompact, a queued prompt, a fast reply. Firing
    // instantly would summon the operator to a lane that is about to carry on.
    expect(stateOf({ shape: 'turn-complete', lastEntryTs: NOW - (TURN_SETTLE_MS - 1) })).toBe('working')
  })

  it('does not care about the process while a lane is moving — the probe is not consulted', () => {
    for (const processAlive of [true, false, null]) {
      expect(stateOf({ shape: 'pending-tool', lastEntryTs: NOW - 1_000, processAlive })).toBe('working')
    }
  })
})

describe('WAITING — the needs-you signal', () => {
  it('raises the hand once a completed turn has stayed completed', () => {
    expect(stateOf({ shape: 'turn-complete', lastEntryTs: NOW - TURN_SETTLE_MS })).toBe('waiting')
    expect(stateOf({ shape: 'turn-complete', lastEntryTs: NOW - 60 * 60_000 })).toBe('waiting')
  })

  it('keeps waiting however long the hand stays up — silence alone is never FROZEN', () => {
    // Law 2: a lane that finished its turn has nothing to be frozen in the
    // middle of. Six hours of quiet with the hand up is still a raised hand.
    expect(
      stateOf({ shape: 'turn-complete', lastEntryTs: NOW - 6 * 60 * 60_000, processAlive: true }),
    ).toBe('waiting')
  })

  it('waits with an unknown process too — a missing probe cannot cancel a summons', () => {
    expect(stateOf({ shape: 'turn-complete', lastEntryTs: NOW - TURN_SETTLE_MS, processAlive: null })).toBe('waiting')
  })
})

describe('the false-summons law (#133) — WAITING requires a completed turn', () => {
  it('never summons from a mid-turn shape, at any silence, with any probe result', () => {
    // Structural, not thresholded: there is no path from a mid-turn shape to
    // `waiting` anywhere in the derivation. Swept across every mid-turn shape,
    // every probe answer, and silences from a second to a week.
    for (const shape of MID_TURN_SHAPES) {
      for (const processAlive of [true, false, null]) {
        for (const quietMs of [0, 1_000, TURN_SETTLE_MS, TRANSCRIPT_STALL_MS, 60 * 60_000, 7 * 24 * 60 * 60_000]) {
          const state = stateOf({ shape, lastEntryTs: NOW - quietMs, processAlive })
          expect(state, `${shape} / alive=${processAlive} / quiet=${quietMs}`).not.toBe('waiting')
        }
      }
    }
  })

  it('does not summon a lane mid-subagent-delegation — the recorded false positive', () => {
    // The #133 shape exactly: the lane called Task, its transcript went quiet
    // for as long as the subagent is busiest, and its process is alive. Before
    // the organ that read as a summons (or a flatline); it must read as work
    // in progress, then as FROZEN only once it outlasts the stall window.
    const delegating = { shape: 'pending-tool' as const, processAlive: true }
    expect(stateOf({ ...delegating, lastEntryTs: NOW - 4 * 60_000 })).toBe('working')
    expect(stateOf({ ...delegating, lastEntryTs: NOW - 30 * 60_000 })).toBe('frozen')
  })
})

describe('FROZEN — stalled mid-turn, still there', () => {
  it('fires once an unfinished turn outlasts the stall window', () => {
    for (const shape of MID_TURN_SHAPES) {
      expect(stateOf({ shape, lastEntryTs: NOW - TRANSCRIPT_STALL_MS, processAlive: true }), shape).toBe('frozen')
    }
  })

  it('is the fallback when the platform cannot probe — unknown is never death', () => {
    // Law 3. macOS and Windows-native return null today; that must degrade to
    // the weaker claim (stalled), never escalate to the stronger one (dead).
    expect(stateOf({ shape: 'mid-stream', lastEntryTs: NOW - TRANSCRIPT_STALL_MS, processAlive: null })).toBe('frozen')
  })

  it('needs a mid-turn shape — a completed turn can never be frozen', () => {
    for (const quietMs of [TRANSCRIPT_STALL_MS, 24 * 60 * 60_000]) {
      expect(stateOf({ shape: 'turn-complete', lastEntryTs: NOW - quietMs, processAlive: true })).not.toBe('frozen')
    }
  })
})

describe('GONE — the process is confirmed absent', () => {
  it('needs an explicit false from the probe, from either side of the turn', () => {
    expect(stateOf({ shape: 'pending-tool', lastEntryTs: NOW - TRANSCRIPT_STALL_MS, processAlive: false })).toBe('gone')
    expect(stateOf({ shape: 'turn-complete', lastEntryTs: NOW - TURN_SETTLE_MS, processAlive: false })).toBe('gone')
  })

  it('is unreachable while the transcript is still inside its window', () => {
    expect(stateOf({ shape: 'pending-tool', lastEntryTs: NOW - 1_000, processAlive: false })).toBe('working')
  })

  it('does not distinguish done from died — that call belongs downstream, to git', () => {
    // prd15 ruling 1. A finished lane whose agent exited and a crashed lane
    // whose agent died look identical from the transcript; the organ reports
    // the fact it has (no process) and leaves the rest to the git witness.
    const finished = deriveLaneState(inputs({ shape: 'turn-complete', lastEntryTs: NOW - 10 * 60_000, processAlive: false }))
    const crashed = deriveLaneState(inputs({ shape: 'pending-tool', lastEntryTs: NOW - 10 * 60_000, processAlive: false }))
    expect(finished?.state).toBe('gone')
    expect(crashed?.state).toBe('gone')
    // The shapes are still carried, so downstream can tell them apart.
    expect(finished?.shape).not.toBe(crashed?.shape)
  })
})

describe('the honest gap — a transcript that has said nothing', () => {
  it('derives no state at all from an empty shape, rather than a fabricated one', () => {
    expect(deriveLaneState(inputs({ shape: 'empty' }))).toBeNull()
    expect(deriveLaneState(inputs({ shape: 'empty', lastEntryTs: null, lastWriteTs: null }))).toBeNull()
  })

  it('falls back to the file clock only when the transcript never timed itself', () => {
    const reading = deriveLaneState(inputs({ shape: 'turn-complete', lastEntryTs: null, lastWriteTs: NOW - 5 * 60_000 }))
    expect(reading?.state).toBe('waiting')
    expect(reading?.quietMs).toBe(5 * 60_000)
  })

  it('reads working when nothing can date the transcript at all', () => {
    // No entry time and no file time is not evidence of a stall. Refusing to
    // escalate on absence is the same rule the probe follows.
    const reading = deriveLaneState(inputs({ lastEntryTs: null, lastWriteTs: null }))
    expect(reading?.state).toBe('working')
    expect(reading?.quietMs).toBeNull()
  })
})

describe('the heartbeat may never postpone a stall (the prd3 keystone bug, shut at its new door)', () => {
  it('ignores a moving mtime when the conversation has stopped', () => {
    // Claude Code appends `last-prompt` / `ai-title` / `mode` after a turn
    // ends — 213 of 253 real transcripts end on one. If write recency gated
    // the thresholds, that bookkeeping would hold a stalled lane "alive"
    // exactly the way a tmux pane repaint once did.
    const stalledButWritten = inputs({
      shape: 'pending-tool',
      lastEntryTs: NOW - 30 * 60_000,
      lastWriteTs: NOW - 500,
      processAlive: true,
    })
    expect(deriveLaneState(stalledButWritten)?.state).toBe('frozen')
  })

  it('reports the heartbeat as evidence even though it decides nothing', () => {
    // Ruling 2: both witnesses flow. The one that lost still speaks.
    const reading = deriveLaneState(
      inputs({ shape: 'turn-complete', lastEntryTs: NOW - 10 * 60_000, lastWriteTs: NOW - 1_000 }),
    )
    expect(reading?.state).toBe('waiting')
    expect(reading?.quietMs).toBe(10 * 60_000)
    expect(reading?.writeQuietMs).toBe(1_000)
    expect(reading?.evidence).toContain('last write')
  })

  it('is decided identically no matter what the mtime says', () => {
    const base = { shape: 'mid-stream' as const, lastEntryTs: NOW - 20 * 60_000, processAlive: true }
    const states = [NOW, NOW - 1_000, NOW - 60 * 60_000, null].map(
      (lastWriteTs) => deriveLaneState(inputs({ ...base, lastWriteTs }))?.state,
    )
    expect(new Set(states)).toEqual(new Set(['frozen']))
  })
})

describe('purity and determinism', () => {
  it('produces byte-equal readings for the same inputs, every time', () => {
    for (const shape of ALL_SHAPES) {
      for (const processAlive of [true, false, null]) {
        for (const quietMs of [0, 30_000, TURN_SETTLE_MS, TRANSCRIPT_STALL_MS, 3 * 60 * 60_000]) {
          const args = inputs({ shape, processAlive, lastEntryTs: NOW - quietMs, lastWriteTs: NOW - quietMs })
          const a = JSON.stringify(deriveLaneState(args))
          const b = JSON.stringify(deriveLaneState({ ...args }))
          expect(a, `${shape}/${processAlive}/${quietMs}`).toBe(b)
        }
      }
    }
  })

  it('never reads a clock of its own — the tick is the only time it knows', () => {
    // Shifting `now` and the transcript's times by the same amount is the same
    // situation, so it must be the same reading. A `Date.now()` anywhere in
    // the derivation would break this.
    const early = deriveLaneState(inputs({ now: 1_000_000, lastEntryTs: 1_000_000 - 90_000, lastWriteTs: 1_000_000 - 90_000 }))
    const late = deriveLaneState(inputs({ now: 9_000_000, lastEntryTs: 9_000_000 - 90_000, lastWriteTs: 9_000_000 - 90_000 }))
    expect(JSON.stringify(early)).toBe(JSON.stringify(late))
  })

  it('clamps a transcript timestamped in the future to zero silence, never a negative age', () => {
    const reading = deriveLaneState(inputs({ lastEntryTs: NOW + 60_000, lastWriteTs: NOW + 60_000 }))
    expect(reading?.quietMs).toBe(0)
    expect(reading?.state).toBe('working')
  })
})

describe('needsProcessProbe — the observer touches nothing while the fleet is healthy', () => {
  it('asks for no probe below the threshold', () => {
    expect(needsProcessProbe('turn-complete', TURN_SETTLE_MS - 1)).toBe(false)
    expect(needsProcessProbe('pending-tool', TRANSCRIPT_STALL_MS - 1)).toBe(false)
    expect(needsProcessProbe('empty', 10 * 60_000)).toBe(false)
    expect(needsProcessProbe('mid-stream', null)).toBe(false)
  })

  it('asks for one exactly where the probe could change the answer', () => {
    expect(needsProcessProbe('turn-complete', TURN_SETTLE_MS)).toBe(true)
    expect(needsProcessProbe('pending-tool', TRANSCRIPT_STALL_MS)).toBe(true)
  })

  it('agrees with the derivation about where the line is', () => {
    // Belt and braces: if the gate and the derivation ever disagreed, a lane
    // would be probed pointlessly or a GONE would be missed.
    for (const shape of ALL_SHAPES) {
      for (const quietMs of [0, TURN_SETTLE_MS - 1, TURN_SETTLE_MS, TRANSCRIPT_STALL_MS - 1, TRANSCRIPT_STALL_MS]) {
        const withDead = deriveLaneState(inputs({ shape, lastEntryTs: NOW - quietMs, processAlive: false }))
        const withUnknown = deriveLaneState(inputs({ shape, lastEntryTs: NOW - quietMs, processAlive: null }))
        const probeMatters = withDead?.state !== withUnknown?.state
        expect(needsProcessProbe(shape, quietMs), `${shape}/${quietMs}`).toBe(probeMatters)
      }
    }
  })
})

describe('publication — edge-triggered, and silent where the union would lie', () => {
  function emissionFor(state: LaneState, previous: LaneState | null) {
    const reading = deriveLaneState(
      inputs(
        state === 'working'
          ? { shape: 'pending-tool', lastEntryTs: NOW - 1_000 }
          : state === 'waiting'
            ? { shape: 'turn-complete', lastEntryTs: NOW - 5 * 60_000 }
            : state === 'frozen'
              ? { shape: 'pending-tool', lastEntryTs: NOW - 30 * 60_000, processAlive: true }
              : { shape: 'pending-tool', lastEntryTs: NOW - 30 * 60_000, processAlive: false },
      ),
    )
    expect(reading?.state).toBe(state)
    return agentStatusEmissionFor({
      handle: 'lane-a',
      worktreePath: '/repo-wt/lane-a',
      branch: 'lane-a',
      previous,
      reading: reading as NonNullable<typeof reading>,
    })
  }

  it('speaks once on the way into working and into waiting', () => {
    expect(emissionFor('working', null)).toMatchObject({ handle: 'lane-a', status: 'working' })
    expect(emissionFor('waiting', 'working')).toMatchObject({ status: 'waiting', elapsedSeconds: 300 })
  })

  it('never repeats itself — a heartbeat would refresh the very silence it reports', () => {
    // buildFleet folds `agent.status` into `lastWorkTs`. Re-announcing a state
    // every poll would postpone FROZEN and inferred-WAITING forever: the prd3
    // keystone bug, which the adapters spike warns every adapter reintroduces
    // if the work/noise split stays implicit.
    expect(emissionFor('working', 'working')).toBeNull()
    expect(emissionFor('waiting', 'waiting')).toBeNull()
  })

  it('publishes nothing for FROZEN — silence is the signal downstream', () => {
    expect(emissionFor('frozen', 'working')).toBeNull()
    expect(emissionFor('frozen', null)).toBeNull()
  })

  it('publishes nothing for GONE — `done` would turn a crash into a success', () => {
    // The union's only candidate word is `done`, and `done` silences the
    // flatline detector outright. Withheld from publication, not from the
    // operator: the state is still in the snapshot.
    expect(emissionFor('gone', 'frozen')).toBeNull()
    expect(emissionFor('gone', 'working')).toBeNull()
  })

  it('signs the payload with the witness that made the observation', () => {
    // Ruling 2, as far as the current envelope allows: the source field is
    // pinned to `workmux` (see the BLOCKED note in lane-state.ts), so `detail`
    // is the only place the second witness can name itself today.
    const emission = emissionFor('waiting', 'working')
    expect(emission?.detail).toMatch(/^transcript-tail: WAITING — tail turn-complete/)
  })
})
