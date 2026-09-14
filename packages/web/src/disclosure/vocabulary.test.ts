import { describe, expect, it } from 'vitest'
import {
  DisclosureError,
  disclosureLines,
  evidenceClause,
  unknownDisclosure,
  type Derivation,
  type DisclosureContent,
} from './vocabulary.js'

/** A whole, honest disclosure — the shape every test below mutates one field of. */
function known(): DisclosureContent {
  return {
    label: 'WAITING',
    why: { reason: 'no output', evidence: { fact: 'last tool call was a file read', elapsedMs: 6 * 60_000 } },
    remedy: { kind: 'action', action: 'attach and see what it is asking', command: 'workmux attach lane-7' },
  }
}

describe('the triple, assembled once (prd-27 ruling 5)', () => {
  it('renders label, why-with-evidence-and-elapsed, and remedy', () => {
    const lines = disclosureLines(known())

    expect(lines.label).toBe('WAITING')
    expect(lines.why).toBe('no output — last tool call was a file read 6m00s ago')
    expect(lines.remedy).toBe('attach and see what it is asking')
    expect(lines.command).toBe('workmux attach lane-7')
  })

  it('spells elapsed in the model’s own duration voice, not a second one', () => {
    // `formatSpan` is `@rhizomorph/core`'s, deliberately: a card that formatted
    // its own durations would drift from the evidence strings the detectors
    // already emit, and "6m00s" would read two ways in one instrument.
    expect(disclosureLines(elapsed(45_000)).why).toContain('45s ago')
    expect(disclosureLines(elapsed(90 * 60_000)).why).toContain('1h30m ago')
  })

  it('accepts a fact observed this instant — zero is measured, not missing', () => {
    // RESTATED, not weakened (#465). The claim is unchanged: zero is a measured
    // observation and must render as one rather than be rejected or blanked.
    // What moved is the wording — `condition.ts`'s own ConditionEvidence
    // docblock says a condition with no "since" date reports 0 meaning
    // "confirmed just now", and rendering that as a DURATION stamped `0s ago`
    // on a trespass path and a token rate. This is stronger than the old
    // assertion because it also forbids the form that shipped the defect.
    expect(disclosureLines(elapsed(0)).why).toContain(', just now')
    expect(disclosureLines(elapsed(0)).why).not.toContain('0s ago')
    expect(disclosureLines(elapsed(0)).why).not.toContain('just now ago')
  })

  it('keeps the command apart from the prose, for a surface that can copy it', () => {
    const lines = disclosureLines(known())
    expect(lines.remedy).not.toContain('workmux attach lane-7')
  })

  it('carries a remedy of none as a stated reason, never as an absent line', () => {
    const lines = disclosureLines({
      ...known(),
      remedy: { kind: 'none', because: 'the lane has landed; nothing is running to act on' },
    })

    expect(lines.remedy).toBe('the lane has landed; nothing is running to act on')
    expect(lines.command).toBeNull()
  })
})

describe('a card with no evidence fails, rather than saying "no data"', () => {
  // The honest-gap voice is the point of prd-30, so it is enforced at both
  // doors. This is the runtime one; the typecheck one is asserted at the
  // bottom of this file, where omitting `evidence` has to fail to compile.

  it('refuses a why with a blank fact, and says which field and why', () => {
    const bare: DisclosureContent = {
      ...known(),
      why: { reason: 'no data', evidence: { fact: '', elapsedMs: 4 * 60_000 } },
    }

    expect(() => disclosureLines(bare)).toThrow(DisclosureError)
    // The message names the field and teaches the fix — "no data" alone is
    // never acceptable, "no data — the collector last answered 4m ago" is.
    expect(() => disclosureLines(bare)).toThrow(/why\.evidence\.fact is empty/)
    expect(() => disclosureLines(bare)).toThrow(/"no data" is a claim with nothing behind it/)
  })

  it('refuses whitespace as evidence — a space is not a fact', () => {
    expect(() =>
      disclosureLines({ ...known(), why: { reason: 'no data', evidence: { fact: '   \n ', elapsedMs: 1 } } }),
    ).toThrow(DisclosureError)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('refuses an elapsed that is %s, rather than rendering it', (_name, elapsedMs) => {
    // `now - null` is `NaN`, and `NaN` renders as evidence-shaped nonsense
    // ("... NaN ago"). A future-dated observation is a clock bug, not an age.
    expect(() => disclosureLines(elapsed(elapsedMs))).toThrow(/elapsedMs is not a measured age/)
  })

  it.each([
    ['label', { label: '  ' }],
    ['why.reason', { why: { reason: '', evidence: { fact: 'the collector last answered', elapsedMs: 1 } } }],
  ] as const)('refuses a blank %s too — every part of the triple or none of it', (field, patch) => {
    expect(() => disclosureLines({ ...known(), ...patch })).toThrow(new RegExp(`${field.replace('.', '\\.')} is empty`))
  })

  it('refuses an empty remedy in either arm', () => {
    expect(() => disclosureLines({ ...known(), remedy: { kind: 'action', action: '' } })).toThrow(
      /remedy\.action is empty/,
    )
    expect(() => disclosureLines({ ...known(), remedy: { kind: 'none', because: '' } })).toThrow(
      /remedy\.because is empty/,
    )
  })

  it('refuses an empty command rather than offering a blank one to copy', () => {
    expect(() =>
      disclosureLines({ ...known(), remedy: { kind: 'action', action: 'attach', command: '   ' } }),
    ).toThrow(/remedy\.command is empty/)
  })

  it('survives a selector handing it undefined where a string was promised', () => {
    // Not a type-system hole to be smug about: selectors are the callers, and
    // this error is more useful at the card's edge than a TypeError from
    // inside it.
    const rigged = { ...known(), why: { reason: undefined, evidence: { fact: 'x', elapsedMs: 0 } } }
    expect(() => disclosureLines(rigged as unknown as DisclosureContent)).toThrow(DisclosureError)
  })
})

describe('the teach layer is assembled here too (prd-30 S2 · #561)', () => {
  function derived(): DisclosureContent {
    return {
      ...known(),
      why: {
        ...known().why,
        derivedFrom: [
          { fact: 'tool call · read', count: 3, elapsedMs: 6 * 60_000 },
          { fact: 'assistant turn ended', elapsedMs: 90 * 60_000 },
        ],
      },
    }
  }

  it('renders each folded fact with its count and its own age', () => {
    // Each line carries its own elapsed time rather than inheriting the why's:
    // a derivation that borrowed the age above it would be asserting a moment
    // it did not observe.
    expect(disclosureLines(derived()).derivation).toEqual([
      'tool call · read ×3 — 6m00s ago',
      'assistant turn ended — 1h30m ago',
    ])
  })

  it('is empty when the selector had nothing further, so the card offers no control', () => {
    // The anti-noise law at its source. Nothing here manufactures a teach layer
    // for a condition with no more facts — #602 is what a surface looks like
    // once every mark has one more thing to say.
    expect(disclosureLines(known()).derivation).toEqual([])
    expect(disclosureLines({ ...known(), why: { ...known().why, derivedFrom: [] } }).derivation).toEqual([])
  })

  it('reaches the teach layer through both remedy arms', () => {
    // The sibling case: `disclosureLines` returns from two places, and a
    // derivation threaded through only the `action` arm would leave every
    // nothing-to-do condition silently unteachable.
    const nothingToDo = disclosureLines({
      ...derived(),
      remedy: { kind: 'none', because: 'the lane has landed; nothing is running to act on' },
    })

    expect(nothingToDo.derivation).toHaveLength(2)
  })

  it('holds the teach layer to the same evidence law as the card above it', () => {
    // The beginner's depth is exactly where a requirement quietly relaxes, so
    // every door the why passes through, a derivation passes through too — and
    // the message names which entry, because "one of your derivations is bad"
    // is not a fixable error.
    const withFact = (patch: Partial<Derivation>): DisclosureContent => ({
      ...known(),
      why: { ...known().why, derivedFrom: [{ fact: 'tool call · read', elapsedMs: 1_000, ...patch }] },
    })

    expect(() => disclosureLines(withFact({ fact: '  ' }))).toThrow(/why\.derivedFrom\[0\]\.fact is empty/)
    expect(() => disclosureLines(withFact({ elapsedMs: Number.NaN }))).toThrow(
      /why\.derivedFrom\[0\]\.elapsedMs is not a measured age/,
    )
    expect(() => disclosureLines(withFact({ elapsedMs: -1 }))).toThrow(/derivedFrom\[0\]\.elapsedMs/)
  })

  it('names the offending entry by index, not just the first one', () => {
    expect(() =>
      disclosureLines({
        ...known(),
        why: {
          ...known().why,
          derivedFrom: [
            { fact: 'tool call · read', elapsedMs: 1_000 },
            { fact: '', elapsedMs: 1_000 },
          ],
        },
      }),
    ).toThrow(/why\.derivedFrom\[1\]\.fact is empty/)
  })

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('refuses a count that is %s rather than rendering "×%s"', (_name, count) => {
    // "×0" reads as evidence and is an absence. An absence is a fact in its own
    // words ("no tool call since the session opened"), not a count of nothing.
    expect(() =>
      disclosureLines({
        ...known(),
        why: { ...known().why, derivedFrom: [{ fact: 'tool call · read', count, elapsedMs: 1_000 }] },
      }),
    ).toThrow(/why\.derivedFrom\[0\]\.count is not a count of observations/)
  })

  it('survives a hole where a selector promised a fact', () => {
    const rigged = { ...known(), why: { ...known().why, derivedFrom: [undefined] } }
    expect(() => disclosureLines(rigged as unknown as DisclosureContent)).toThrow(DisclosureError)
  })
})

describe('the unknown card names what is missing and which rung would prove it', () => {
  const input = {
    mark: 'WAITING',
    missing: 'no declared attention from the lane',
    elapsedMs: 4 * 60_000,
    at: 'L1',
  } as const

  it('is a whole disclosure — it passes the same evidence law as every other card', () => {
    const lines = disclosureLines(unknownDisclosure(input))

    expect(lines.label).toBe('unknown — WAITING')
    expect(lines.why).toBe(
      'no row in the condition table for WAITING — no declared attention from the lane, last evidence 4m00s ago',
    )
    expect(lines.remedy).toContain('L2 would prove it')
    // The climb text is `@rhizomorph/core`'s ladder, not a second vocabulary.
    expect(lines.remedy).toContain('a hook beacon declares attention')
  })

  it('at the top rung, says the table itself is what is missing', () => {
    // L4 has nothing above it. A remedy that suggested climbing anyway would
    // be the improvisation this state exists to replace.
    const lines = disclosureLines(unknownDisclosure({ ...input, at: 'L4' }))

    expect(lines.remedy).toContain('nothing further to climb')
    expect(lines.remedy).toContain("condition table's own row")
    expect(lines.command).toBeNull()
  })

  it('carries a teach layer like any other card, over the facts it does hold', () => {
    // The unknown arm is where requirements go to relax, so it goes through the
    // same derivation as everything else — S2's *unknown* state is the same
    // honest gap at more length, not a second, softer one.
    const lines = disclosureLines(
      unknownDisclosure({ ...input, derivedFrom: [{ fact: 'hook beacon last seen', elapsedMs: 4 * 60_000 }] }),
    )

    expect(lines.derivation).toEqual(['hook beacon last seen — 4m00s ago'])
    expect(disclosureLines(unknownDisclosure(input)).derivation).toEqual([])
  })

  it('refuses to build an unknown that cannot say what is missing', () => {
    expect(() => unknownDisclosure({ ...input, missing: '' })).toThrow(DisclosureError)
    expect(() => unknownDisclosure({ ...input, mark: ' ' })).toThrow(DisclosureError)
  })
})

describe('the shape itself forbids an evidence-free card (typecheck door)', () => {
  it('will not compile a why without evidence', () => {
    // This assertion runs at `npm run typecheck`, not here: if `evidence` ever
    // became optional, the directive below would be unused and `tsc` would fail
    // on it. The runtime guards above are the second door, not the only one.
    const missingEvidence: DisclosureContent = {
      ...known(),
      // @ts-expect-error evidence is required — a why without it is the bare "no data" prd-30 forbids
      why: { reason: 'no data' },
    }

    expect(() => disclosureLines(missingEvidence)).toThrow(DisclosureError)
  })
})

function elapsed(elapsedMs: number): DisclosureContent {
  return { ...known(), why: { reason: 'no data', evidence: { fact: 'the collector last answered', elapsedMs } } }
}

/**
 * #465 — the rules, one test each, at the boundary rather than in the middle.
 *
 * The old suite was green while four of the five shipped conditions rendered a
 * defective sentence, because every assertion pinned one condition's whole
 * string and the defect was in what the composition did to all of them. These
 * test the rule; `panels/fleet/format.test.ts` sweeps every producer for the
 * property.
 */
describe('evidenceClause — the age is stated once, and only when there is one', () => {
  it('leaves a fact that already states the span exactly as it found it', () => {
    // The FROZEN shape. Identity, not `toContain`: appending anything at all
    // is the defect, so a containment assertion would pass on the bug.
    const fact = 'no events for 16m37s'
    expect(evidenceClause(fact, 16 * 60_000 + 37_000)).toBe(fact)
  })

  it('leaves a multi-clause fact alone rather than dating its LAST clause', () => {
    // The WAITING shape, and the one that was not merely untidy: the fact is a
    // `·`-joined list whose FIRST clause carries the "ago", so an appended one
    // landed on the last and asserted that workmux reported *working* 8m17s
    // ago. What the evidence says is that two witnesses disagree.
    const fact = 'beacon (claude-hook) declares waiting 8m17s ago · workmux reports working'
    expect(evidenceClause(fact, 8 * 60_000 + 17_000)).toBe(fact)
  })

  it('states a zero age in words — "confirmed just now", never as a duration', () => {
    const clause = evidenceClause('55.4× fleet median', 0)
    expect(clause).toBe('55.4× fleet median, just now')
    expect(clause).not.toMatch(/\b0s ago/)
    expect(clause).not.toContain('just now ago')
  })

  it('appends an ordinary measured age — the one shape that must NOT move', () => {
    // LOOPING renders correctly today and is the regression guard for the fix.
    expect(evidenceClause('Bash→Read→Edit ×21, no commit', 4 * 60_000)).toBe(
      'Bash→Read→Edit ×21, no commit 4m00s ago',
    )
  })

  it('appends the measured span even when the fact quotes a different one', () => {
    // A fact mentioning some OTHER duration is not a fact that has been dated.
    const clause = evidenceClause('waited 3m00s for the lock', 45_000)
    expect(clause).toBe('waited 3m00s for the lock 45s ago')
  })

  it('introduces the teach layer\'s age with its own separator', () => {
    expect(evidenceClause('tool call ×3', 45_000, ' — ')).toBe('tool call ×3 — 45s ago')
  })

  it('is pure — the same input twice is the same string, with nothing accumulated', () => {
    const once = evidenceClause('a fact', 45_000)
    const twice = evidenceClause('a fact', 45_000)
    expect(twice).toBe(once)
    expect(evidenceClause(once, 45_000)).toBe(once)
  })
})

/**
 * The sibling case, tested where it can actually fail.
 *
 * `panels/fleet/format.test.ts`'s sweep asserts the same property over
 * `lines.derivation`, and that half of it is VACUOUS: none of the eleven
 * producers in that module supplies `derivedFrom`, so the loop never iterates.
 * Found by reverting the teach-line fix and watching the whole suite stay green
 * — 84 passed with the defect restored. The property is kept there for the
 * twelfth producer that does supply one; THESE are the tests that fail today if
 * the teach layer regresses.
 */
describe('the teach layer composes the same way, and has the same defect to avoid (#465)', () => {
  function withDerivation(derivedFrom: readonly Derivation[]): DisclosureContent {
    return { ...known(), why: { ...known().why, derivedFrom } }
  }

  it('does not repeat a span the derivation fact already states', () => {
    const lines = disclosureLines(
      withDerivation([{ fact: 'no events for 16m37s', elapsedMs: 16 * 60_000 + 37_000 }]),
    )
    expect(lines.derivation).toEqual(['no events for 16m37s'])
  })

  it('states a zero-aged derivation in words, not as a zero duration', () => {
    const lines = disclosureLines(withDerivation([{ fact: 'fence check ran', elapsedMs: 0 }]))
    expect(lines.derivation[0]).toBe('fence check ran, just now')
    expect(lines.derivation[0]).not.toMatch(/\b0s ago/)
  })

  it('keeps the ordinary teach shape — fact, count, then the age', () => {
    const lines = disclosureLines(withDerivation([{ fact: 'tool call', count: 3, elapsedMs: 45_000 }]))
    expect(lines.derivation[0]).toBe('tool call ×3 — 45s ago')
  })
})
