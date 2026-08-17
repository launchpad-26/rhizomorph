import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALARM_FLOOR, CALM_CEILING, CALM_FLOOR, RECEDE } from '../scene/salience.js'
import { resolveMotion, type ResolvedMotion } from './apply.js'
import {
  assertRegistryHonest,
  auditPreference,
  auditRegistry,
  FORBIDDEN_NAMESPACES,
  IMMOVABLE_CONSTANTS,
  NON_NEGOTIABLES,
  offerTextOf,
  type NonNegotiableId,
} from './non-negotiables.js'
import { entryOf, PREFERENCES, type PrefEntry } from './registry.js'

/**
 * RULING 2's LAW (prd-35 S2, #550) — the five things that may never become a
 * preference, and the proof that saying so costs something.
 *
 * A law nobody has watched fail is a comment. So this file does two things and
 * they are not the same thing: it asserts the real registry is clean, and it
 * RIGS one violation per entry and asserts the law goes red on each — five
 * rigged controls, five reds, each red naming the entry it broke and the reason
 * that entry is on the list. The reasons are in `non-negotiables.ts`, deliberately
 * beside the rule, so the next person to want the toggle reads why before they
 * read no.
 *
 * The probes call {@link assertRegistryHonest} — THE function the law runs over
 * the real registry — rather than re-implementing its matching. That is
 * `mutating-calls-law.test.ts`'s own scar: a probe that re-implements the
 * mechanism stays green when the mechanism is reverted, and pins nothing.
 */

const SETTINGS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(SETTINGS_DIR, '..')

/** A control that does not exist, shaped exactly like one that could. */
function rig(overrides: Partial<PrefEntry> & Pick<PrefEntry, 'id' | 'label'>): PrefEntry {
  return {
    group: 'appearance',
    what: 'a control somebody wanted, one release after this law was written.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    words: null,
    fallback: false,
    control: 'settings',
    unavailable: null,
    requires: null,
    gap: null,
    legacy: null,
    ...overrides,
  }
}

/**
 * One rigged control per non-negotiable, each written the way it would actually
 * arrive — as a reasonable-sounding request, not as an obvious attack. Nobody
 * proposes "lie to me"; they propose a quieter alert, an exact number, a tidier
 * screenshot.
 */
const RIGGED: ReadonlyArray<{ law: NonNegotiableId; entry: PrefEntry }> = [
  {
    law: 'alarm-band',
    entry: rig({
      id: 'alarm.quietMode',
      label: 'Calmer alerts',
      kind: 'choice',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'quiet', label: 'Quiet — dim the alarm band' },
      ],
      fallback: 'normal',
    }),
  },
  {
    law: 'honest-gap',
    entry: rig({ id: 'honesty.hideGapVoices', label: 'Hide honest-gap warnings' }),
  },
  {
    law: 'estimate-flag',
    entry: rig({
      id: 'costs.estimateDisplay',
      label: 'Show estimated costs as exact figures',
    }),
  },
  {
    law: 'zero-with-evidence',
    entry: rig({ id: 'panels.zeroRows', label: 'Collapse zero-with-evidence rows' }),
  },
  {
    law: 'simulated-real',
    entry: rig({ id: 'chrome.simulatedBanner', label: 'Hide the simulated-data banner' }),
  },
]

describe('ruling 2 — the five non-negotiables, as law', () => {
  it('names exactly five, because a sixth is a change to what the instrument claims about itself', () => {
    expect(NON_NEGOTIABLES.map((law) => law.id)).toEqual([
      'alarm-band',
      'honest-gap',
      'estimate-flag',
      'zero-with-evidence',
      'simulated-real',
    ])
    // Each carries its reason, and the reason is a sentence rather than a label
    // — the point of the list is that it argues, not that it forbids.
    for (const law of NON_NEGOTIABLES) {
      expect(law.why.length, `${law.id} states no reason`).toBeGreaterThan(80)
    }
  })

  it('holds on the registry as it actually is', () => {
    expect(() => assertRegistryHonest()).not.toThrow()
    expect(auditRegistry()).toEqual([])
  })

  it('has something to check — an empty registry would pass vacuously', () => {
    expect(PREFERENCES.length).toBeGreaterThanOrEqual(6)
    // …and the audit really reads each entry, rather than an empty string.
    for (const entry of PREFERENCES) {
      expect(offerTextOf(entry)).toContain(entry.id)
      expect(offerTextOf(entry)).toContain(entry.label)
    }
  })

  // ── the five reds ─────────────────────────────────────────────────────────
  //
  // One `it` per entry, deliberately: five separate failures, so a law that
  // stopped biting on ONE of the five is not hidden behind the four it still
  // catches.

  for (const { law, entry } of RIGGED) {
    it(`fails on a control that would weaken ${law} — "${entry.label}"`, () => {
      expect(
        () => assertRegistryHonest([...PREFERENCES, entry]),
        `${entry.id} passed the law that exists to refuse it`,
      ).toThrow(new RegExp(law))

      // For the right reason, and naming the right entry: a law that fired on
      // every rigged control for the same generic reason would be five reds
      // proving one thing.
      const violations = auditPreference(entry)
      expect(violations.map((violation) => violation.nonNegotiable)).toContain(law)
      expect(violations.every((violation) => violation.entryId === entry.id)).toBe(true)
      expect(violations.find((violation) => violation.nonNegotiable === law)?.why.length).toBeGreaterThan(80)
    })
  }

  /**
   * WAVE 2's OWN EXPOSURE (#574). The Notifications group is the first set of
   * controls whose honest form and whose forbidden form look almost identical —
   * "do not interrupt me when a lane needs a human" is a preference, and "dim
   * the band when a lane needs a human" is the thing the instrument may never
   * be told. The six that landed are audited by the block above along with
   * everything else; this proves the line between them is a line the law can
   * actually see, by walking a control across it.
   */
  it('lets a notification be muted and refuses the same switch reaching the band', () => {
    const muting = rig({
      id: 'notifications.needsHuman',
      label: 'A lane needs a human',
      what: 'whether a lane that has stopped for you interrupts you. It is in the picture either way.',
    })
    expect(auditPreference(muting)).toEqual([])

    // One clause further, and it is a different control entirely.
    const reaching = rig({ id: 'notifications.calmBand', label: 'Dim the alarm band while muted' })
    expect(auditPreference(reaching).map((violation) => violation.nonNegotiable)).toContain('alarm-band')
    expect(() => assertRegistryHonest([...PREFERENCES, reaching])).toThrow(/alarm-band/)
  })

  it('audits the wave-2 groups rather than only the two the law was written beside', () => {
    // #574 added ten controls under two new groups. A law that only ever saw
    // `appearance.*` and `motion.*` would have been green for all of them.
    for (const group of ['notifications', 'application'] as const) {
      const entries = PREFERENCES.filter((entry) => entry.group === group)
      expect(entries.length, `${group} declares nothing`).toBeGreaterThan(0)
      for (const entry of entries) expect(auditPreference(entry), `${entry.id}`).toEqual([])
    }
  })

  it('is not simply refusing everything — a real control that says nothing about the five passes', () => {
    const innocent = rig({
      id: 'appearance.wallpaper',
      label: 'Background texture',
      kind: 'choice',
      options: [
        { value: 'plain', label: 'Plain' },
        { value: 'grain', label: 'Grain' },
      ],
      fallback: 'plain',
    })
    expect(auditPreference(innocent)).toEqual([])
    expect(() => assertRegistryHonest([...PREFERENCES, innocent])).not.toThrow()
  })

  it('refuses a protected concern in the id namespace even under a bland label', () => {
    // The cheapest way past a word-pair test is an innocuous label over a
    // pointed key, so the namespace fails on its own.
    const bland = rig({ id: 'attention.mode', label: 'Mode' })
    expect(auditPreference(bland).map((violation) => violation.nonNegotiable)).toEqual(['alarm-band'])

    for (const [namespace, law] of Object.entries(FORBIDDEN_NAMESPACES)) {
      expect(auditPreference(rig({ id: `${namespace}.something`, label: 'Something' })).length).toBeGreaterThan(0)
      expect(
        auditPreference(rig({ id: `${namespace}.something`, label: 'Something' }))[0]?.nonNegotiable,
      ).toBe(law)
    }
  })

  it('reads what a control OFFERS, not the prose explaining why it is refused', () => {
    // This file, `registry.ts` and the page all say words like *hide* and
    // *missing* while arguing AGAINST hiding things — the honest-gap voice is
    // made of those words. An audit that read the explanation would fire on the
    // sentence that defends the rule, so the audit reads id, label and options.
    const explained = rig({
      id: 'appearance.contrast',
      label: 'Contrast',
      what: 'nothing here hides an alarm, suppresses a gap voice or dismisses the demo banner.',
      gap: 'the zero-with-evidence rows are unaffected; no estimate is shown as exact.',
      unavailable: 'this would otherwise hide the attention ladder, which it may never do.',
    })
    expect(auditPreference(explained)).toEqual([])
  })
})

describe('the four immovable numbers — no setting may move them', () => {
  /**
   * They are law elsewhere (`scene/salience.ts`), and this pins the values so
   * the ban below is a ban on something specific rather than on four strings.
   */
  it('are what they are', () => {
    expect([RECEDE, CALM_CEILING, ALARM_FLOOR, CALM_FLOOR]).toEqual([0.3, 0.78, 0.84, 0.15])
    expect(IMMOVABLE_CONSTANTS).toEqual(['RECEDE', 'CALM_CEILING', 'ALARM_FLOOR', 'CALM_FLOOR'])
  })

  it('are not named by anything under settings/ — no control reaches them, not even to read them', () => {
    const sources = settingsSources()
    expect(sources.length).toBeGreaterThan(3)

    for (const source of sources) {
      // `non-negotiables.ts` names them once, in the declaration this law reads
      // them from. That one mention is removed before the scan, so the file is
      // held to the same rule as its siblings for every OTHER mention.
      const text = source.text.replace(/IMMOVABLE_CONSTANTS[^=]*=[\s\S]*?\]/, '')
      for (const constant of IMMOVABLE_CONSTANTS) {
        expect(text, `${source.name} names ${constant}`).not.toContain(constant)
      }
    }
  })
})

describe('ruling 5 — the motion control may go beyond the system request, never below it', () => {
  const RANK: Readonly<Record<ResolvedMotion, number>> = { full: 0, reduced: 1, still: 2 }

  it('never returns more motion than the system asked for — over every option the control offers', () => {
    const options = entryOf('motion.level').options
    expect(options.length).toBeGreaterThan(0)

    for (const option of options) {
      const underReduced = resolveMotion(option.value, { prefersLight: false, prefersReducedMotion: true })
      expect(RANK[underReduced], `${option.value} overrode prefers-reduced-motion upward`).toBeGreaterThanOrEqual(
        RANK.reduced,
      )
    }
  })

  it('holds for an option that does not exist yet, which is the point of a floor', () => {
    // A future `full`/`always` option cannot get past the floor either — the
    // rule is arithmetic over the resolved value, not a check of today's three.
    expect(resolveMotion('full', { prefersLight: false, prefersReducedMotion: true })).toBe('reduced')
    expect(resolveMotion('anything-at-all', { prefersLight: false, prefersReducedMotion: true })).toBe('reduced')

    // …and it is not simply pinning everything to `reduced`: with the system
    // asking for nothing, the person's own answer stands, in both directions.
    expect(resolveMotion('still', { prefersLight: false, prefersReducedMotion: false })).toBe('still')
    expect(resolveMotion('system', { prefersLight: false, prefersReducedMotion: false })).toBe('full')
    // Beyond is allowed: `still` under a merely-reduced system stays `still`.
    expect(resolveMotion('still', { prefersLight: false, prefersReducedMotion: true })).toBe('still')
  })
})

interface SourceFile {
  name: string
  text: string
}

/** Every non-test source file under `settings/`. */
function settingsSources(): SourceFile[] {
  const out: SourceFile[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      out.push({ name: path.relative(WEB_SRC, full), text: readFileSync(full, 'utf8') })
    }
  }
  visit(SETTINGS_DIR)
  return out
}
