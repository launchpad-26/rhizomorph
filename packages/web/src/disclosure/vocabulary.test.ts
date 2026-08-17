import { describe, expect, it } from 'vitest'
import {
  DisclosureError,
  disclosureLines,
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
    expect(disclosureLines(elapsed(0)).why).toContain('0s ago')
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
