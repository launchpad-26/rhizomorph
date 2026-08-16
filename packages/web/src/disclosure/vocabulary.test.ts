import { describe, expect, it } from 'vitest'
import {
  DisclosureError,
  disclosureLines,
  unknownDisclosure,
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
