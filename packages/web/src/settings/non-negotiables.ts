import { PREFERENCES, type PrefEntry } from './registry.js'

/**
 * THE NON-NEGOTIABLES (prd-35 ruling 2 / S2, #550; sixth entry prd-50 ruling
 * 2, #236) — the six things that may never become a preference, as
 * executable law rather than as a paragraph.
 *
 * **Read the reasons before wanting the toggle.** They are in
 * {@link NON_NEGOTIABLES} below, one per entry, and they are the point of this
 * file. The mechanism is crude on purpose, in the same posture as
 * `replay/mutating-calls-law.test.ts`: a settings surface is exactly where
 * "make the alarms quieter" arrives wearing a reasonable face, and the answer
 * has to be structural rather than a matter of taste on the day someone asks.
 *
 * **How it bites.** Every control the settings page renders must be declared in
 * `registry.ts` first — `coverage-law.test.tsx` proves that the rendered set and
 * the declared set are the same set, so there is no path to a toggle that
 * skips this audit. Each declared entry is then read for what it OFFERS a
 * person: its id, its label, and the labels and values of its options. If that
 * text both NAMES a protected mechanism and offers to WEAKEN it, the entry is a
 * violation and `non-negotiables-law.test.ts` goes red.
 *
 * **Why the offer text and not the whole entry.** An entry's `what`/`gap`/
 * `unavailable` prose is where the honest-gap voice lives, and that voice
 * legitimately says words like *hide*, *missing* and *unavailable* while
 * explaining why something is NOT hidden. Auditing the explanation would make
 * the law fire on the sentence that argues against the very thing it forbids —
 * so the audit reads what the control puts in front of a person, which is also
 * the only part a person can act on.
 *
 * **Two detectors, deliberately overlapping.** A concern named in an entry's id
 * NAMESPACE fails on the namespace alone ({@link FORBIDDEN_NAMESPACES}), before
 * any wording question — because the cheapest way past a word-pair test is a
 * bland label over a pointed key. The pair test catches the opposite trick: an
 * innocuous namespace with the intent spelled out in the label.
 *
 * **What this file cannot do**, said plainly rather than left to be discovered:
 * it reads text, so a control named `appearance.mode` whose values secretly
 * silence the attention strip passes here. That is why ruling 2's real
 * enforcement is two-layered — this law over what is DECLARED, and the existing
 * per-mechanism laws (`theme/category.ts`'s caps, `scene/salience.ts`'s bands,
 * the gap voices' own tests) over what is DRAWN. A toggle that reached the band
 * without naming it would still have to get past those.
 *
 * **The sixth entry, `lab-lock-ceiling`, is a different shape.** The other
 * five are guarded by matching a RENDERED browser control's offer text; this
 * one guards the lab CLI lock ceiling, a SERVER-side constant that has no
 * rendered control to match at all — a preference surface can only ever see
 * what it renders. (Its exact name is deliberately not spelled here: the
 * server-side law that actually enforces it, named below, asserts that name
 * is read from exactly one module, and a second file citing it by name would
 * make that assertion false for no reason.) Its `names` regex a few lines
 * down is not what enforces it and is not presented as such: it is a
 * defensive catch for the narrower case where someone later adds a BROWSER
 * control that offers to raise or disable the ceiling, same as the other
 * five. What actually keeps the value fixed is ruling 1: the number is fixed
 * BY RULE, and moving it takes a reviewed diff, the same discipline every
 * value in this codebase answers to. `packages/server/src/api/lab-ceiling-law.test.ts`
 * adds a narrower, mechanical backstop on top of that — it reads the server
 * module directly and fails the suite on the concrete wiring points this
 * constant has today (an assignment inside the function that uses it, a
 * config-derived call argument, a second seam set from production code), so
 * that class of change cannot land silently. It is a text scan of one file,
 * not a proof that no configuration path could ever reach the constant —
 * "no environment variable, config-file key, request field or preference
 * reaches it" is a claim about every possible program, and three rounds of
 * adversarial review confirmed a scan of current text cannot decide that in
 * general. That file's own doc says exactly which known wirings it fails and
 * which shapes of change (an alias, a wrapper, a runtime-computed property
 * write, a decoy that defeats its own body extractor) it does not see. This
 * entry is the register of the rule; that file is a check on the obvious way
 * of breaking it, not a proof the rule cannot be broken.
 */

export type NonNegotiableId =
  | 'alarm-band'
  | 'honest-gap'
  | 'estimate-flag'
  | 'zero-with-evidence'
  | 'simulated-real'
  | 'lab-lock-ceiling'

export interface NonNegotiable {
  readonly id: NonNegotiableId
  readonly name: string
  /** Ruling 2's own reason, verbatim in substance. The next person to want the toggle reads this first. */
  readonly why: string
  /** What naming this mechanism looks like in a control's id, label or options. */
  readonly names: RegExp
}

/**
 * Ruling 2's table, as data. **Exactly six**, and a seventh entry is a change to
 * the instrument's claim about itself, not a config change — so it lands in a
 * diff a reviewer reads, with its reason beside it, exactly as these six did.
 */
export const NON_NEGOTIABLES: readonly NonNegotiable[] = [
  {
    id: 'alarm-band',
    name: 'the alarm band and the attention ladder',
    why: 'the band is the mechanism by which a dying lane reaches a human. A "calmer alerts" mode is a mode in which the instrument stops doing its one job — and the band is a ratio, not a brightness, so quieting it does not make the instrument gentler, it makes it blind.',
    names: /\balarm\b|\balarms\b|attention ladder|\bladder\b|salience|summons|escalation/i,
  },
  {
    id: 'honest-gap',
    name: 'honest-gap voices',
    why: 'a hidden warning is a claim that nothing is wrong. Law 12 exists because the absence of a flag reads as evidence of absence: an operator who has switched the gap voices off cannot tell an instrumented-and-quiet fleet from an uninstrumented one.',
    names: /honest[- ]gap|gap voice|\bgaps?\b|unproven|\bhonesty\b|\bremedy\b/i,
  },
  {
    id: 'estimate-flag',
    name: 'estimate flags and cost provenance',
    why: '"show costs as exact" would make an estimate indistinguishable from a measurement. Dollars are vendored, flagged, or absent — never invented (prd-9 ruling 7) — and the flag is the only thing carrying which of the three you are looking at.',
    names: /estimat|provenance|unflag|vendored/i,
  },
  {
    id: 'zero-with-evidence',
    name: 'zero-with-evidence',
    why: '"collisions: 0 — checked 47 branches" may never collapse into a hidden panel or a bare blank; a zero with its evidence, a zero without it, and nothing at all are three different claims, and only the first one is a measurement.',
    names: /zero[- ]with[- ]evidence|\bzero\b|\bevidence\b/i,
  },
  {
    id: 'simulated-real',
    name: 'the simulated/real distinction',
    why: 'demo chrome is not themeable, dismissible or hideable. A screenshot of simulated data must never be mistakable for telemetry — which is a property of every screenshot ever taken of this instrument, not of the session the person taking it was in.',
    names: /simulat|\bdemo\b|\bfixture\b|synthetic|sample fleet/i,
  },
  {
    id: 'lab-lock-ceiling',
    name: 'the lab CLI lock ceiling',
    why: 'the ceiling is the mechanism by which a launch that would wait silently behind another one refuses rather than queuing. prd-12 ruling 3 forbids the trade an operator would make by raising it — spend hidden behind latency — and a configurable threshold here is a supported way to rebuild the queue prd-41 ruling 2 already refused (prd-50 ruling 1). This entry is the register, not the guard: there is no rendered control to weigh, because the value lives in the server, so the regex below only catches the narrower case of a future BROWSER control naming it. What actually keeps the value fixed is ruling 1 itself — a fixed value, changed only in a reviewed diff — and a server-side test that fails the wiring points this constant has today; that test is a text scan of one file, not a proof that no configuration path could ever reach it, and it says so in its own doc.',
    names: /\blab\b.*\bceiling\b|\bceiling\b.*\blab\b|lock ceiling|lab[- ]cli[- ]lock/i,
  },
]

/**
 * What "make it weaker" sounds like, whatever it is aimed at. Deliberately the
 * vocabulary of a reasonable-sounding feature request, because that is the form
 * the danger actually takes — nobody proposes "lie to me".
 */
const WEAKENING =
  /\bhide|hidden|\bhiding\b|dismiss|suppress|silence|\bmute\b|\bquiet|calmer|soften|\bdim\b|snooze|\boff\b|disable|\bomit\b|collapse|\bblank\b|\bexact\b|precise|ignore|opt[- ]out/i

/**
 * Id namespaces that fail on sight, and the entry each answers to. A key whose
 * very namespace is one of the five protected mechanisms has already lost the
 * argument: there is no honest preference that belongs under `alarm.`.
 */
export const FORBIDDEN_NAMESPACES: Readonly<Record<string, NonNegotiableId>> = {
  alarm: 'alarm-band',
  alarms: 'alarm-band',
  attention: 'alarm-band',
  salience: 'alarm-band',
  honesty: 'honest-gap',
  gaps: 'honest-gap',
  estimates: 'estimate-flag',
  provenance: 'estimate-flag',
  evidence: 'zero-with-evidence',
  demo: 'simulated-real',
  simulated: 'simulated-real',
}

/**
 * The four numbers no setting may move, named here so the law can prove no file
 * under `settings/` so much as mentions them. They are law elsewhere
 * (`scene/salience.ts`) and this module does not own them — it owns the promise
 * that nothing configurable reaches them.
 */
export const IMMOVABLE_CONSTANTS: readonly string[] = [
  'RECEDE',
  'CALM_CEILING',
  'ALARM_FLOOR',
  'CALM_FLOOR',
]

export interface Violation {
  readonly entryId: string
  readonly nonNegotiable: NonNegotiableId
  /** The text that gave it away, so a red says what to look at rather than only that something is wrong. */
  readonly matched: string
  /** Why this may never be a preference — ruling 2's reason, carried to the failure. */
  readonly why: string
}

/** What an entry OFFERS a person: its identity, its label, and every option it puts in front of them. */
export function offerTextOf(entry: PrefEntry): string {
  const options = entry.options.map((option) => `${option.value} ${option.label}`).join(' ')
  return `${entry.id} ${entry.label} ${options}`.trim()
}

function whyOf(id: NonNegotiableId): string {
  const found = NON_NEGOTIABLES.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no non-negotiable is declared under ${id}`)
  return found.why
}

/** Every way one entry breaks ruling 2. Empty for an entry that does not. */
export function auditPreference(entry: PrefEntry): Violation[] {
  const violations: Violation[] = []
  const text = offerTextOf(entry)

  const namespace = entry.id.split('.')[0] ?? ''
  const byNamespace = FORBIDDEN_NAMESPACES[namespace.toLowerCase()]
  if (byNamespace !== undefined) {
    violations.push({
      entryId: entry.id,
      nonNegotiable: byNamespace,
      matched: `${namespace}.`,
      why: whyOf(byNamespace),
    })
  }

  for (const law of NON_NEGOTIABLES) {
    if (violations.some((violation) => violation.nonNegotiable === law.id)) continue
    const named = law.names.exec(text)
    const weakened = WEAKENING.exec(text)
    if (named === null || weakened === null) continue
    violations.push({
      entryId: entry.id,
      nonNegotiable: law.id,
      matched: `${named[0]} … ${weakened[0]}`,
      why: law.why,
    })
  }

  return violations
}

/** The whole registry, audited. The law asserts this is empty; the rigged entries prove it can be otherwise. */
export function auditRegistry(entries: readonly PrefEntry[] = PREFERENCES): Violation[] {
  return entries.flatMap(auditPreference)
}

/** A violation, said out loud — what failed, which law it broke, and why that law exists. */
export function describeViolation(violation: Violation): string {
  return `${violation.entryId} would weaken ${violation.nonNegotiable} (matched: ${violation.matched}) — ${violation.why}`
}

/**
 * THE LAW ITSELF, as one function. `non-negotiables-law.test.ts` asserts it does
 * not throw on the real registry and asserts it DOES throw on a rigged control
 * for each of the six — so the mechanism guarding the registry is the same
 * mechanism proven able to fail, rather than a re-implementation of it beside a
 * green bar (the shape `replay/mutating-calls-law.test.ts` had to be corrected
 * into on 2026-08-09).
 */
export function assertRegistryHonest(entries: readonly PrefEntry[] = PREFERENCES): void {
  const violations = auditRegistry(entries)
  if (violations.length === 0) return
  throw new Error(`ruling 2 — ${violations.map(describeViolation).join(' · ')}`)
}
