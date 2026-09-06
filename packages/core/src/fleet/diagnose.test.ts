import { describe, expect, it } from 'vitest'
import { diagnose, NAMED_TRESPASSES, type DiagnoseContext } from './diagnose.js'
import type { Trespass } from './fences.js'
import type { Lane } from './types.js'

/**
 * OFF-FENCE'S EVIDENCE IS BOUNDED AT THE SOURCE (walkthrough, 2026-08-17).
 *
 * A human walked the running instrument and found the attention strip
 * truncating a trespass path mid-word. The cause was not the view: this
 * detector joined **every** trespass path with ` · ` into one unbounded string,
 * and the 18rem chip that rendered it was doing the only thing it could with a
 * sentence thousands of characters long.
 *
 * The clause is `Pathology.evidence` and five surfaces read it — the attention
 * chip, the fleet table's STATE title, the peek's evidence line,
 * `selectLaneCondition`, and the run view's outcome. Clipping it in the view
 * would have fixed the one surface with the narrowest box and left the other
 * four rendering a sentence nobody can finish.
 *
 * Every assertion below is written against **forty** trespasses, because one is
 * the case the original author considered and forty is the case that broke.
 */

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0)

function ctx(): DiagnoseContext {
  return {
    now: NOW,
    medianOutputPerMin: 100,
    expensiveThreshold: Number.POSITIVE_INFINITY,
    paneActivityTs: null,
    agentStatusTs: null,
    agentStatusDetail: null,
    agentStatusDissent: null,
    commitTs: null,
  }
}

/** A lane with nothing wrong with it but its fence, so off-fence is the only pathology returned. */
function laneWith(trespasses: Trespass[]): Lane {
  return {
    id: '600-offender',
    fenced: true,
    trespasses,
    // Everything else quiet enough that no other detector fires: recent work,
    // no repeating tool cycle, no waiting declaration, no burn outlier.
    lastEventTs: NOW - 1_000,
    workAgeMs: 1_000,
    ageMs: 60_000,
    recentTools: [],
    outputPerMin: 1,
    activity: 'working',
    present: true,
    parked: false,
    declared: null,
    pathologies: [],
  } as unknown as Lane
}

function trespasses(count: number): Trespass[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `packages/web/src/panels/attention/very/long/path/number-${i}.tsx`,
    victim: `61${i}-other-lane`,
  }))
}

function offFenceEvidence(lane: Lane): string {
  const found = diagnose(lane, ctx()).find((pathology) => pathology.kind === 'off-fence')
  expect(found, 'off-fence did not fire on a fenced lane with trespasses').toBeDefined()
  return found?.evidence ?? ''
}

describe('off-fence names a bounded number of paths and counts the rest', () => {
  it('is short enough to read in a chip at forty trespasses', () => {
    const forty = offFenceEvidence(laneWith(trespasses(40)))

    // THE MUTATION THIS EXISTS FOR, as arithmetic. The unbounded join produced
    // 40 × ~70 characters; this bound is far below that and far above one path,
    // so it fails in both directions — a regression to the join, and an
    // over-eager truncation that stopped naming a path at all.
    expect(forty.length).toBeLessThan(160)
    expect(forty.length).toBeGreaterThan(40)
  })

  it('names the count, names the first path in full, and says how many more', () => {
    const forty = offFenceEvidence(laneWith(trespasses(40)))

    expect(forty).toContain('40 files outside fence')
    // The first path is WHOLE — truncating it mid-word is exactly the bug.
    expect(forty).toContain('packages/web/src/panels/attention/very/long/path/number-0.tsx → 610-other-lane')
    expect(forty).toContain(`+${40 - NAMED_TRESPASSES} more`)
    // …and no other path leaked in.
    expect(forty).not.toContain('number-1.tsx')
    expect(forty).not.toContain('number-39.tsx')
  })

  it('does not count at one — a lone breach reads as the path it is', () => {
    // "1 file outside fence — <path>" beside the one path it names reads as an
    // instrument that cannot count. This is also the shape `buildFleet.test.ts`
    // has pinned since #226, so the single case is unchanged by the bound.
    const one = offFenceEvidence(
      laneWith([{ path: 'packages/core/src/selectors/spend-subrows.ts', victim: '46-spend-selectors' }]),
    )
    expect(one).toBe('outside fence — packages/core/src/selectors/spend-subrows.ts → 46-spend-selectors')
    expect(one).not.toContain('more')
  })

  it('counts from two, and the count is the total rather than the remainder', () => {
    // The off-by-one a "+N more" implementation invites: N is what is hidden,
    // and the headline is what exists. Two paths, one named, one hidden.
    const two = offFenceEvidence(laneWith(trespasses(2)))
    expect(two).toContain('2 files outside fence')
    expect(two).toContain('+1 more')
  })

  it('names an unclaimed path without inventing a victim', () => {
    const orphan = offFenceEvidence(laneWith([{ path: 'docs/adr/README.md', victim: null }]))
    expect(orphan).toBe('outside fence — docs/adr/README.md')
    expect(orphan).not.toContain('→')
  })

  it('does not fire at all on an unfenced lane, or on a fenced lane inside its fence', () => {
    // Without this the assertions above would be equally green against a
    // detector that fired on everything.
    const unfenced = { ...laneWith(trespasses(3)), fenced: false } as Lane
    expect(diagnose(unfenced, ctx()).some((p) => p.kind === 'off-fence')).toBe(false)
    expect(diagnose(laneWith([]), ctx()).some((p) => p.kind === 'off-fence')).toBe(false)
  })
})

/**
 * WAITING'S EVIDENCE NAMES ITS WITNESS (#281, ADR-0037).
 *
 * `detectWaiting`'s declared branch used to have exactly one sentence for
 * every raised hand. It now has three, and which one it speaks is decided by
 * two facts that arrive through different doors: `Lane.agentStatusWitness`
 * (the fold's record of who spoke) and `DiagnoseContext.agentStatusDissent`
 * (the word a standing declaration refused). Both are asserted here at the
 * detector's own level, so a regression is localised to this function rather
 * than only showing up four hops away in `buildFleet.test.ts`.
 */
describe('WAITING names its witness (#281, ADR-0037)', () => {
  const ORGAN_WAITING = 'WAITING — tail turn-complete, quiet 45s, threshold 30s'

  /** A lane with its hand up and nothing else wrong with it. */
  function waitingLane(witness: 'workmux' | 'sessionlog' | null): Lane {
    return {
      id: '281-witness',
      fenced: false,
      trespasses: [],
      agentStatus: 'waiting',
      agentStatusWitness: witness,
      present: true,
      parked: false,
      telemetryOnly: false,
      lastEventTs: NOW - 90_000,
      lastWorkTs: NOW - 90_000,
      workAgeMs: 90_000,
      ageMs: 90_000,
      recentTools: [],
      outputPerMin: 1,
      activity: 'waiting',
      declared: null,
      pathologies: [],
    } as unknown as Lane
  }

  function waitingEvidence(lane: Lane, overrides: Partial<DiagnoseContext> = {}): string {
    const found = diagnose(lane, { ...ctx(), agentStatusTs: NOW - 90_000, ...overrides }).find(
      (pathology) => pathology.kind === 'waiting',
    )
    expect(found, 'waiting did not fire on a lane with its hand up').toBeDefined()
    return found?.evidence ?? ''
  }

  function waitingPathology(lane: Lane, overrides: Partial<DiagnoseContext> = {}) {
    return diagnose(lane, { ...ctx(), agentStatusTs: NOW - 90_000, ...overrides }).find(
      (pathology) => pathology.kind === 'waiting',
    )
  }

  it('a declaration nobody contradicted reads exactly as it always did', () => {
    // The pre-#281 sentence, unchanged: the dissent clause appends nothing
    // when there is no dissent, rather than leaving a dangling separator.
    expect(waitingEvidence(waitingLane('workmux'))).toBe('workmux reports waiting 1m30s')
    expect(waitingPathology(waitingLane('workmux'))?.inferred).toBe(false)
  })

  it('a declaration the organ contradicted names the disagreement beside itself', () => {
    const evidence = waitingEvidence(waitingLane('workmux'), {
      agentStatusDissent: { witness: 'sessionlog', status: 'working', ts: NOW - 10_000, detail: null },
    })
    expect(evidence).toBe('workmux reports waiting 1m30s; transcript shape reads working')
    // Still certain: the declaration stands, ruling 4. The dissent is a
    // sentence beside it, never a downgrade of it.
    expect(
      waitingPathology(waitingLane('workmux'), {
        agentStatusDissent: { witness: 'sessionlog', status: 'working', ts: NOW - 10_000, detail: null },
      })?.inferred,
    ).toBe(false)
  })

  it('an organ-witnessed hand is inferred, and quotes the transcript\'s own reading', () => {
    const lane = waitingLane('sessionlog')
    expect(waitingEvidence(lane, { agentStatusDetail: ORGAN_WAITING })).toBe(
      `transcript shape: ${ORGAN_WAITING}`,
    )
    expect(waitingPathology(lane, { agentStatusDetail: ORGAN_WAITING })?.inferred).toBe(true)
  })

  it('an organ-witnessed hand with no detail says so rather than printing null', () => {
    expect(waitingEvidence(waitingLane('sessionlog'), { agentStatusDetail: null })).toBe(
      'transcript shape: no reading recorded',
    )
  })
})

/**
 * THE THIRD WITNESS, AT THE DETECTOR (prd-27 rulings 3–4, #283).
 *
 * `buildFleet.test.ts` proves the same asymmetry end-to-end through a real
 * event log; this block pins the **strings** at `detectWaiting`'s own level,
 * byte for byte, because the disagreement voice is a rendered sentence and
 * "deterministic to the byte" is the ruling's own wording. A regression that
 * only changes the wording is invisible to a `kind === 'waiting'` assertion
 * and reddens here.
 */
describe('detectWaiting through diagnose() — the declared voice, byte-exact (prd-27, #283)', () => {
  const WRITER = 'claude-hook'

  /**
   * A lane with no roster word and no fresh *work*, but very much alive: the
   * pane inference cannot fire (no `paneActivityTs`), so whatever comes back is
   * the beacon's doing.
   *
   * `ageMs` is deliberately small while `workAgeMs` is large — the work-age /
   * liveness-age split `detectWaiting` is built on. A lane whose *events* are
   * `FROZEN_AFTER_MS` old is FROZEN, and `diagnose` suppresses WAITING behind
   * FROZEN by design (silence means exactly one thing), which would make every
   * assertion in this block vacuously `undefined`.
   */
  function declaredLane(overrides: Partial<Lane> = {}): Lane {
    return {
      id: '283-declared',
      fenced: false,
      trespasses: [],
      agentStatus: null,
      agentStatusWitness: null,
      present: true,
      parked: false,
      telemetryOnly: false,
      lastEventTs: NOW - 1_000,
      ageMs: 1_000,
      lastWorkTs: NOW - 10 * 60_000,
      workAgeMs: 10 * 60_000,
      recentTools: [],
      outputPerMin: 1,
      activity: 'idle',
      declared: null,
      pathologies: [],
      ...overrides,
    } as unknown as Lane
  }

  function waiting(lane: Lane, overrides: Partial<DiagnoseContext> = {}) {
    return diagnose(lane, { ...ctx(), ...overrides }).find((pathology) => pathology.kind === 'waiting')
  }

  /** The pane-stillness inference's shape: quiet past the threshold, pane still moving. */
  function paneInferredLane(overrides: Partial<Lane> = {}): Lane {
    return declaredLane({ lastWorkTs: NOW - 160_000, workAgeMs: 160_000, ...overrides })
  }
  const PANE_FRESH: Partial<DiagnoseContext> = { paneActivityTs: NOW - 1_000 }

  it('(a) a declared waiting is a certain WAITING since the beacon fired', () => {
    const found = waiting(declaredLane({ declared: { kind: 'waiting', at: NOW - 40_000, writer: WRITER } }))
    expect(found?.evidence).toBe('beacon (claude-hook) declares waiting 40s ago')
    expect(found?.inferred).toBe(false)
    expect(found?.since).toBe(NOW - 40_000)
  })

  it('(c1) an organ inferring working never suppresses it — the disagreement is voiced', () => {
    const found = waiting(
      declaredLane({
        declared: { kind: 'waiting', at: NOW - 40_000, writer: WRITER },
        agentStatus: 'working',
        agentStatusWitness: 'sessionlog',
      }),
    )
    expect(found?.evidence).toBe('beacon (claude-hook) declares waiting 40s ago · transcript shape reads working')
    expect(found?.inferred).toBe(false)
  })

  it('(c2) recent work never suppresses it either, and says so', () => {
    const found = waiting(
      declaredLane({
        declared: { kind: 'waiting', at: NOW - 40_000, writer: WRITER },
        lastWorkTs: NOW - 5_000,
        workAgeMs: 5_000,
      }),
    )
    expect(found?.evidence).toBe('beacon (claude-hook) declares waiting 40s ago · recent work reads working')
  })

  it('(b3) a declared working OLDER than the last work quiets nothing, and the inference says why', () => {
    const found = waiting(
      paneInferredLane({ declared: { kind: 'working', at: NOW - 300_000, writer: WRITER } }),
      PANE_FRESH,
    )
    expect(found?.evidence).toBe(
      'quiet 2m40s, pane still alive · beacon (claude-hook) declared working 5m00s ago, before the last work',
    )
    expect(found?.inferred).toBe(true)
  })

  /**
   * (b3)'s sibling against the *other* inference. `staleDeclaredWorking` is
   * appended in two places — the transcript-shape arm and the pane-stillness
   * arm — and (b3) above only ever exercised the second, so dropping the
   * clause from the sessionlog arm alone left the suite green (review of #296).
   */
  it('(b3, sibling) a stale declared working is named on the transcript-shape inference too (#281)', () => {
    const found = waiting(
      paneInferredLane({
        agentStatus: 'waiting',
        agentStatusWitness: 'sessionlog',
        declared: { kind: 'working', at: NOW - 300_000, writer: WRITER },
      }),
    )
    expect(found?.evidence).toBe(
      'transcript shape: no reading recorded · beacon (claude-hook) declared working 5m00s ago, before the last work',
    )
    expect(found?.inferred).toBe(true)
  })

  it('(b1) a declared working NEWER than the last work quiets the pane inference outright', () => {
    const found = waiting(
      paneInferredLane({ declared: { kind: 'working', at: NOW - 5_000, writer: WRITER } }),
      PANE_FRESH,
    )
    expect(found).toBeUndefined()
  })

  it('(d) a declared stopped alarms nothing and appends nothing to an inference that stands', () => {
    const alone = waiting(declaredLane({ declared: { kind: 'stopped', at: NOW - 20_000, writer: WRITER } }))
    expect(alone).toBeUndefined()

    const beside = waiting(
      paneInferredLane({ declared: { kind: 'stopped', at: NOW - 20_000, writer: WRITER } }),
      PANE_FRESH,
    )
    expect(beside?.evidence).toBe('quiet 2m40s, pane still alive')
    expect(beside?.inferred).toBe(true)
  })

  it('a workmux waiting with an older beacon stopped voices the beacon beside it', () => {
    const found = waiting(
      declaredLane({
        agentStatus: 'waiting',
        agentStatusWitness: 'workmux',
        declared: { kind: 'stopped', at: NOW - 120_000, writer: WRITER },
      }),
      { agentStatusTs: NOW - 90_000 },
    )
    expect(found?.evidence).toBe('workmux reports waiting 1m30s · beacon (claude-hook) declared stopped 2m00s ago')
    expect(found?.inferred).toBe(false)
  })

  /**
   * The `lane.present` guard on clause (a), pinned (verify of #283: dropping it
   * left every test green). A beacon record stands in `state.declared` for as
   * long as the session does, but a worktree that has been removed has landed —
   * the same honesty exemption FROZEN and the workmux arm apply — so a declared
   * `waiting` on an absent lane must not summon anyone to a lane nobody can
   * attach to (#133's shape). Without this, every landed lane whose last word
   * was `waiting` would raise a hand forever.
   */
  it('(a) a declared waiting on a removed worktree raises no summons — the record outlives the lane, the alarm must not', () => {
    const found = waiting(declaredLane({ present: false, declared: { kind: 'waiting', at: NOW - 40_000, writer: WRITER } }))
    expect(found).toBeUndefined()
  })
})
