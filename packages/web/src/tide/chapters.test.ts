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
