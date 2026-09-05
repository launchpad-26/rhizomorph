import { createEventFactory, type EventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { CHAPTER_KINDS, chapterLabel, chaptersFor, type Chapter } from './chapters.js'
import { TIDE_LANES, TIDE_START_TS } from './fixtures.js'

const T0 = TIDE_START_TS
const MINUTE = 60_000

function log(build: (fx: ReturnType<typeof createEventFactory>) => void): RhizomorphEvent[] {
  const fx = createEventFactory({ startTs: T0, stepMs: 0 })
  build(fx)
  return fx.all()
}

// ── a local generator, extended beyond `fixtures.ts`'s shared one so gate-held,
// session-boundary, and the four kinds #277 adds (summons-raised/cleared,
// gate-verdict, operator-verdict) — kinds the shared generator never produces —
// get property coverage too, without touching a fixture other tide tests
// depend on.

function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state
  }
}

function pick<T>(items: readonly T[], next: () => number): T {
  return items[next() % items.length] as T
}

const STEPS_MS = [0, 1_000, 30_000, 90_000, 400_000]

type Emit = (fx: EventFactory, lane: string) => RhizomorphEvent

const EMITTERS: readonly Emit[] = [
  (fx, lane) => fx.agentStatus({ handle: lane, status: 'working' }),
  (fx, lane) => fx.agentStatus({ handle: lane, status: 'waiting' }),
  (fx, lane) => fx.agentStatus({ handle: lane, status: 'done' }),
  (fx, lane) => fx.llmUsage({ lane }),
  (fx, lane) => fx.toolActivity({ lane }),
  (fx, lane) => fx.traceSpan({ lane, kind: 'llm_request' }),
  (fx, lane) => fx.traceSpan({ lane, kind: 'tool_blocked', toolName: 'Bash', decision: 'accept' }),
  (fx) => fx.sessionStarted(),
  (fx) => fx.commitLanded(),
  (fx) => fx.paneActivity(),
  (fx, lane) => fx.summonsRaised({ lane, kind: 'awaiting-reply' }),
  (fx, lane) => fx.summonsCleared({ lane, kind: 'awaiting-reply' }),
  (fx, lane) => fx.gateVerdict({ handle: lane, held: true }),
  (fx, lane) => fx.gateVerdict({ handle: lane, held: false }),
  (fx, lane) => fx.operatorVerdict({ subject: lane, verdict: 'approved' }),
  (fx, lane) => fx.operatorVerdict({ subject: lane, verdict: 'held' }),
]

const SEEDS = [1, 7, 42, 1_337, 90_210]

function generateChapterLog(seed: number, count: number): RhizomorphEvent[] {
  const next = lcg(seed)
  const fx = createEventFactory({ startTs: T0, stepMs: 0, idPrefix: `ch${seed}` })
  let clock = T0
  const events: RhizomorphEvent[] = []
  for (let i = 0; i < count; i += 1) {
    clock += pick(STEPS_MS, next)
    fx.at(clock)
    events.push(pick(EMITTERS, next)(fx, pick(TIDE_LANES, next)))
  }
  return events
}

function ofKind(chapters: readonly Chapter[], kind: Chapter['kind']): Chapter[] {
  return chapters.filter((c) => c.kind === kind)
}

// ── the story each kind tells ────────────────────────────────────────────────

describe('chaptersFor — lane-born', () => {
  it('marks a lane at its earliest event, whichever event type that is', () => {
    const events = log((fx) => {
      fx.at(T0 + 5 * MINUTE).llmUsage({ lane: 'ke5' })
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + 10 * MINUTE).toolActivity({ lane: 'ke5' })
    })

    const born = ofKind(chaptersFor(events), 'lane-born')
    expect(born).toEqual([{ kind: 'lane-born', ts: T0, lane: 'ke5', toolName: null, held: null, verdict: null }])
  })

  it('emits exactly one lane-born per lane, never one per event', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + MINUTE).agentStatus({ handle: 'ke5', status: 'waiting' })
      fx.at(T0 + 2 * MINUTE).agentStatus({ handle: 'ke5', status: 'done' })
    })

    expect(ofKind(chaptersFor(events), 'lane-born')).toHaveLength(1)
  })

  it('ignores facts keyed by branch, path or pane — the same universe bandsFor reads', () => {
    const events = log((fx) => {
      fx.at(T0).paneActivity()
      fx.at(T0 + MINUTE).commitLanded()
      fx.at(T0 + 2 * MINUTE).worktreeDirty()
    })

    expect(chaptersFor(events)).toEqual([])
  })
})

describe('chaptersFor — lane-landed', () => {
  it('marks a lane at its earliest `done` declaration', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + 80 * MINUTE).agentStatus({ handle: 'ke5', status: 'done' })
      fx.at(T0 + 85 * MINUTE).agentStatus({ handle: 'ke5', status: 'done' })
    })

    expect(ofKind(chaptersFor(events), 'lane-landed')).toEqual([
      { kind: 'lane-landed', ts: T0 + 80 * MINUTE, lane: 'ke5', toolName: null, held: null, verdict: null },
    ])
  })

  it('never fires for a lane that has not declared done', () => {
    const events = log((fx) => {
      fx.at(T0).agentStatus({ handle: 'ke5', status: 'working' })
      fx.at(T0 + MINUTE).agentStatus({ handle: 'ke5', status: 'waiting' })
    })

    expect(ofKind(chaptersFor(events), 'lane-landed')).toEqual([])
  })
})

describe('chaptersFor — gate-held', () => {
  it('marks every resolved permission wait, carrying which tool it was', () => {
    const events = log((fx) => {
      fx.at(T0).traceSpan({ lane: 'ke5', kind: 'tool_blocked', toolName: 'Bash', decision: 'accept' })
      fx.at(T0 + MINUTE).traceSpan({ lane: 'ke5', kind: 'tool_blocked', toolName: 'Edit', decision: 'reject' })
    })

    expect(ofKind(chaptersFor(events), 'gate-held')).toEqual([
      { kind: 'gate-held', ts: T0, lane: 'ke5', toolName: 'Bash', held: null, verdict: null },
      { kind: 'gate-held', ts: T0 + MINUTE, lane: 'ke5', toolName: 'Edit', held: null, verdict: null },
    ])
  })

  it('never fires for a span of any other kind', () => {
    const events = log((fx) => {
      fx.at(T0).traceSpan({ lane: 'ke5', kind: 'llm_request' })
      fx.at(T0 + MINUTE).traceSpan({ lane: 'ke5', kind: 'tool_execution' })
    })

    expect(ofKind(chaptersFor(events), 'gate-held')).toEqual([])
  })
})

describe('chaptersFor — session-boundary', () => {
  it('marks a session.started event, naming no lane', () => {
    const events = log((fx) => {
      fx.at(T0).sessionStarted()
    })

    expect(chaptersFor(events)).toEqual([
      { kind: 'session-boundary', ts: T0, lane: null, toolName: null, held: null, verdict: null },
    ])
  })
})

// ── attention-summons onset (the ladder rank) still has no event; the
// alarm pair, the gate's verdict and the operator's own word do now ───────

describe('chaptersFor — the kinds this file emits, exactly', () => {
  it('never emits a kind outside the eight with a real event behind them', () => {
    expect(CHAPTER_KINDS).toEqual([
      'lane-born',
      'lane-landed',
      'gate-held',
      'session-boundary',
      'summons-raised',
      'summons-cleared',
      'gate-verdict',
      'operator-verdict',
    ])
    for (const seed of SEEDS) {
      for (const chapter of chaptersFor(generateChapterLog(seed, 200))) {
        expect(CHAPTER_KINDS).toContain(chapter.kind)
      }
    }
  })
})

describe('chaptersFor — summons-raised', () => {
  it('marks every raise, one chapter per event', () => {
    const events = log((fx) => {
      fx.at(T0).summonsRaised({ lane: 'ke5', kind: 'awaiting-reply' })
      fx.at(T0 + MINUTE).summonsRaised({ lane: 'ke5', kind: 'stalled' })
    })

    expect(ofKind(chaptersFor(events), 'summons-raised')).toEqual([
      { kind: 'summons-raised', ts: T0, lane: 'ke5', toolName: null, held: null, verdict: null },
      { kind: 'summons-raised', ts: T0 + MINUTE, lane: 'ke5', toolName: null, held: null, verdict: null },
    ])
  })

  it('is a mark, not an error, when the raise is never cleared — a session can end mid-alarm', () => {
    const events = log((fx) => {
      fx.at(T0).summonsRaised({ lane: 'ke5', kind: 'awaiting-reply' })
    })

    expect(ofKind(chaptersFor(events), 'summons-raised')).toHaveLength(1)
    expect(ofKind(chaptersFor(events), 'summons-cleared')).toEqual([])
  })
})

describe('chaptersFor — summons-cleared', () => {
  it('marks every clear, one chapter per event, independent of any raise', () => {
    const events = log((fx) => {
      fx.at(T0).summonsCleared({ lane: 'ke5', kind: 'awaiting-reply' })
    })

    expect(ofKind(chaptersFor(events), 'summons-cleared')).toEqual([
      { kind: 'summons-cleared', ts: T0, lane: 'ke5', toolName: null, held: null, verdict: null },
    ])
  })
})

describe('chaptersFor — gate-verdict', () => {
  it('marks a held verdict as "held"', () => {
    const events = log((fx) => {
      fx.at(T0).gateVerdict({ handle: 'ke5', held: true })
    })

    expect(ofKind(chaptersFor(events), 'gate-verdict')).toEqual([
      { kind: 'gate-verdict', ts: T0, lane: 'ke5', toolName: null, held: true, verdict: null },
    ])
  })

  it('marks a released verdict as "merged" — the sibling case a fixed verb would get wrong', () => {
    const events = log((fx) => {
      fx.at(T0).gateVerdict({ handle: 'ke5', held: false })
    })

    const [chapter] = ofKind(chaptersFor(events), 'gate-verdict')
    expect(chapter?.held).toBe(false)
    expect(chapterLabel(chapter as Chapter)).toBe('ke5 merged · 14:00:00')
  })
})

describe('chaptersFor — operator-verdict', () => {
  it('marks every operator verdict, carrying the subject as lane and the verdict word verbatim', () => {
    const events = log((fx) => {
      fx.at(T0).operatorVerdict({ subject: '219', verdict: 'approved' })
    })

    expect(ofKind(chaptersFor(events), 'operator-verdict')).toEqual([
      { kind: 'operator-verdict', ts: T0, lane: '219', toolName: null, held: null, verdict: 'approved' },
    ])
  })
})

// ── a flood of any new kind still coalesces like any other dense run ──────

describe('chaptersFor — a flood of summonses is still one mark under density', () => {
  it('does not exempt the new kinds from the sort/coalesce path', () => {
    const events = log((fx) => {
      for (let i = 0; i < 20; i += 1) {
        fx.at(T0 + i).summonsRaised({ lane: 'ke5', kind: 'stalled' })
      }
    })

    const chapters = ofKind(chaptersFor(events), 'summons-raised')
    expect(chapters).toHaveLength(20)
    // chaptersFor itself does not coalesce — that is coalesceMarks's job
    // (ChapterMarks.test.tsx pins the rendered, coalesced result); this
    // only pins that every one of the 20 raises survives as its own real
    // fact, in ts order, ready for coalesceMarks to cluster.
    for (let i = 0; i < chapters.length; i += 1) expect(chapters[i]?.ts).toBe(T0 + i)
  })

  /**
   * The clause above cannot see the sort at all, and the issue said so before
   * either was written: "Emit the new kinds unsorted — append them after the
   * existing sort instead of inside it. Every single-kind test passes; only an
   * assertion over a log mixing an old kind and a new one at interleaved
   * timestamps catches it." Filtering to one kind with `ofKind` is exactly the
   * single-kind shape it named.
   *
   * **The first version of this test was itself too weak, and that is the
   * lesson worth keeping** (review of #277, round 2). It mixed the kinds but
   * emitted them at ASCENDING timestamps, so "push in log order and never sort
   * at all" produced a byte-identical array: deleting `chapters.sort` outright
   * left the whole `tide/` suite green, this assertion included. It constrained
   * SEGREGATION — new kinds bucketed to the end — and not ORDERING, while its
   * title claimed the second. Re-using the one mutation that found a defect as
   * the proof its fix works is how that happened; the class was never probed.
   *
   * So the log below arrives OUT of ts order — by ts rank, (2nd, 1st, 1st, 1st,
   * 2nd, 3rd, 3rd) — which is the only shape that can tell a real sort from no
   * sort at all.
   *
   * **Every chapter kind appears, and that is a rule rather than thoroughness**
   * (review of #277, round 3). A hoist can be written per kind, so a fixture
   * missing one kind has no witness for that kind's hoist: an independent seat
   * showed that appending ONLY `gate-verdict`, or ONLY `summons-cleared`, left
   * all 188 tide tests green while the all-four spelling reddened. Two of
   * #277's own four new kinds had no ordering witness anywhere in the repo.
   *
   * **A kind that sorts LAST is structurally invisible to a solo hoist**, since
   * appending something already last cannot move it — so such a kind must also
   * appear at a second, earlier ts. That is why `session.started` is emitted
   * twice. The round-2 fixture put it at the maximum ts alone, which silently
   * gave up a witness the round-1 fixture had: the only axis on which that
   * version was WEAKER than the one it replaced.
   */
  it('orders every kind by ts, whatever order the log arrived in', () => {
    const events = log((fx) => {
      fx.at(T0 + 3 * MINUTE).sessionStarted()
      // the same kind again at the EARLIEST ts — without this, hoisting
      // `session-boundary` out of the sort is invisible: it already sorts last.
      fx.at(T0).sessionStarted()
      // `gate-held`, and it pulls `lane-born` to T0 so the @2m group stays a
      // pair rather than a triple — the `kind` tiebreak stays load-bearing.
      fx.at(T0).traceSpan({ lane: 'ke5', kind: 'tool_blocked', toolName: 'Bash', decision: 'accept' })
      // the two of #277's four new kinds that had no ordering witness at all.
      fx.at(T0 + MINUTE).summonsCleared({ lane: 'ke5', kind: 'stalled' })
      fx.at(T0 + MINUTE).gateVerdict({ handle: 'ke5', held: true })
      fx.at(T0 + MINUTE).summonsRaised({ lane: 'ke5', kind: 'stalled' })
      // the only lane-bearing event, so `bornAt`/`landedAt` both resolve here:
      // two DEFERRED kinds at one ts, pushed AFTER the main loop.
      fx.at(T0 + 2 * MINUTE).agentStatus({ handle: 'ke5', status: 'done' })
      // deliberately at the SAME ts and the SAME lane as those two, and pushed
      // BEFORE them — so insertion order and `kind` order actively disagree.
      // Without that the `kind` tiebreak is satisfied by V8's stability instead
      // of by the comparator, which is how the first version of this fixture
      // passed while the clause was removable.
      fx.at(T0 + 2 * MINUTE).operatorVerdict({ subject: 'ke5', verdict: 'approved' })
    })

    const chapters = chaptersFor(events)
    expect(chapters.map((chapter) => [chapter.kind, chapter.ts - T0])).toEqual([
      ['gate-held', 0],
      ['lane-born', 0],
      ['session-boundary', 0],
      ['gate-verdict', MINUTE],
      ['summons-cleared', MINUTE],
      ['summons-raised', MINUTE],
      // one ts, two chapters, and the `kind` tiebreak alone decides them:
      // `operator.verdict` is pushed in the main loop and `lane-landed` after
      // it, so insertion order and `kind` order actively DISAGREE. (They are
      // not simply reversed — only `operator-verdict` moves — but disagreeing
      // is the whole requirement: without it V8's stable sort would satisfy
      // this assertion while the clause was removable.)
      ['lane-landed', 2 * MINUTE],
      ['operator-verdict', 2 * MINUTE],
      ['session-boundary', 3 * MINUTE],
    ])
  })

  /**
   * The comparator's third clause. `chaptersFor`'s own note says the sort makes
   * the output well-ordered "regardless" of input order, and the `lane` tiebreak
   * is the half of that claim nothing reached: dropping it left the suite green,
   * because V8's sort is stable and every fixture happened to emit in the order
   * the tiebreak would have chosen. Two raises at ONE ts, emitted
   * reverse-alphabetically, is the case where stability and the tiebreak
   * disagree — so it fails if the clause is removed.
   */
  it('breaks a ts tie between two lanes by lane, not by arrival', () => {
    const events = log((fx) => {
      fx.at(T0).summonsRaised({ lane: 'zulu', kind: 'stalled' })
      fx.at(T0).summonsRaised({ lane: 'alpha', kind: 'stalled' })
    })

    expect(chaptersFor(events).map((chapter) => chapter.lane)).toEqual(['alpha', 'zulu'])
  })
})

// ── the ruling-6 voice ───────────────────────────────────────────────────────

describe('chapterLabel — who/what/when, ruling-6 voice', () => {
  it('reads exactly ruling 12\'s own example', () => {
    const chapter: Chapter = {
      kind: 'lane-landed',
      ts: Date.UTC(2026, 7, 4, 14, 32, 7),
      lane: '163',
      toolName: null,
      held: null,
      verdict: null,
    }
    expect(chapterLabel(chapter)).toBe('163 landed · 14:32:07')
  })

  it('names the tool a gate held on, when the span said', () => {
    const chapter: Chapter = {
      kind: 'gate-held',
      ts: T0,
      lane: 'ke5',
      toolName: 'Bash',
      held: null,
      verdict: null,
    }
    expect(chapterLabel(chapter)).toBe('ke5 held on Bash · 14:00:00')
  })

  it('names "session" rather than a lane for a session boundary', () => {
    const chapter: Chapter = {
      kind: 'session-boundary',
      ts: T0,
      lane: null,
      toolName: null,
      held: null,
      verdict: null,
    }
    expect(chapterLabel(chapter)).toBe('session started · 14:00:00')
  })

  it('names a landing gate verdict "held" or "merged", never a fixed verb for both', () => {
    const held: Chapter = { kind: 'gate-verdict', ts: T0, lane: 'ke5', toolName: null, held: true, verdict: null }
    const merged: Chapter = { kind: 'gate-verdict', ts: T0, lane: 'ke5', toolName: null, held: false, verdict: null }
    expect(chapterLabel(held)).toBe('ke5 held · 14:00:00')
    expect(chapterLabel(merged)).toBe('ke5 merged · 14:00:00')
  })

  it("carries the operator's own verdict word verbatim, not a paraphrase", () => {
    const chapter: Chapter = {
      kind: 'operator-verdict',
      ts: T0,
      lane: '219',
      toolName: null,
      held: null,
      verdict: 'approved',
    }
    expect(chapterLabel(chapter)).toBe('219 approved · 14:00:00')
  })
})

// ── the seek law: every mark's ts is a real event's ts, exactly ────────────

describe('chaptersFor — every chapter\'s ts is a real event\'s ts', () => {
  it('never invents an instant no event attested', () => {
    for (const seed of SEEDS) {
      const events = generateChapterLog(seed, 200)
      const eventTimes = new Set(events.map((event) => event.ts))
      for (const chapter of chaptersFor(events)) expect(eventTimes.has(chapter.ts)).toBe(true)
    }
  })
})

// ── prefix-consistency: the keystone's law, restated for marks ─────────────

describe('chaptersFor — over a prefix equals the whole, truncated', () => {
  it('matches the whole log\'s chapters filtered to the same instant', () => {
    for (const seed of SEEDS) {
      const events = generateChapterLog(seed, 160)
      const whole = chaptersFor(events)
      const cuts = [...new Set(events.map((event) => event.ts))]

      for (const cut of cuts) {
        const prefix = events.filter((event) => event.ts <= cut)
        const expected = whole.filter((chapter) => chapter.ts <= cut)
        expect(chaptersFor(prefix)).toEqual(expected)
      }
    }
  })
})

// ── determinism ──────────────────────────────────────────────────────────────

describe('chaptersFor — determinism', () => {
  it('returns byte-equal chapters for the same events, every time', () => {
    for (const seed of SEEDS) {
      const events = generateChapterLog(seed, 200)
      const once = JSON.stringify(chaptersFor(events))
      const twice = JSON.stringify(chaptersFor(events))
      const rebuilt = JSON.stringify(chaptersFor(generateChapterLog(seed, 200)))
      expect(twice).toBe(once)
      expect(rebuilt).toBe(once)
    }
  })

  it('reads no clock: an empty log has no chapters', () => {
    expect(chaptersFor([])).toEqual([])
  })
})
