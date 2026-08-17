import { formatSpan, nextRung, rungInfo, type Rung } from '@rhizomorph/core'

/**
 * THE DISCLOSURE VOCABULARY (prd-30 ruling 1 and S1, over prd-27 ruling 5's
 * triple · #554) — the one shape every explanation in the instrument takes,
 * and the one place it is assembled into strings.
 *
 * Three parts, in this order, always: **label · why · remedy.** The order is
 * fixed here rather than agreed by convention, because the failure prd-30 is
 * built against is "two surfaces phrasing one condition differently" (S1,
 * *what would make it wrong*), and a shape that lets a caller choose is a
 * shape that lets two callers choose differently.
 *
 * **The why carries evidence and elapsed time, and that is not optional.**
 * `Why.evidence` is a required field, so a card without evidence fails
 * typecheck before it renders, and {@link disclosureLines} rejects a blank or
 * unmeasurable one at runtime, because a selector can hand a blank string
 * where a type cannot. The reason both doors are shut: this instrument's whole
 * posture is that it says what it knows *and how it knows it*. "No data" alone
 * is the sentence a dashboard says when it would rather not admit which part
 * is broken; "no data — the collector last answered 4m00s ago" is a fact with
 * its provenance attached, and it is the only one of the two that a reader can
 * act on. Making the evidence optional would make the honest version the
 * polite default rather than the law, and defaults erode.
 *
 * **The remedy is required too, and its empty case has to say why it is
 * empty.** {@link Remedy} is a union rather than an optional string: a
 * condition with nothing to do renders `kind: 'none'` *with a reason*, so the
 * third line is never silently missing. An optional remedy would let "there is
 * nothing you can do" and "nobody wrote this one yet" render identically —
 * S1's *"a remedy that names no action"* failure, arrived at by omission.
 *
 * **The teach layer is assembled here too, and that is the whole of it**
 * (prd-30 ruling 4 and S2 · #561). `Why.derivedFrom` carries the events, counts
 * and timestamps the condition was derived from, and
 * {@link DisclosureLines.derivation} is what a card renders. There is no second
 * voice and no beginner register: the teach lines are the same facts the
 * selector already used, at more length, in the same words. S2 asks for a test
 * that "no string in the teach layer exists outside the condition table" — the
 * teach layer having *no strings of its own to test* is the strongest way to
 * pass it, and `teach-law.test.tsx` asserts exactly that against the rendered
 * card.
 *
 * **A derivation is optional, and that is the anti-noise law.** Nothing here
 * manufactures a teach layer for a condition that has no further facts: an
 * empty `derivation` means the card offers no control at all. prd-30's problem
 * statement is a person who cannot read a mark; #602 is the other failure — 282
 * lines of individually-correct honest-gap prose burying a page. A card that
 * always had one more thing to say would be walking into the second one.
 *
 * **No clock is read here.** Elapsed time arrives as `elapsedMs`, computed by
 * the caller against its own reading position, which is what makes replay
 * identical to live (S1, *replay*): at a scrub position the elapsed times are
 * relative to that position, and a card that called `Date.now()` would report
 * the age of a fact against a clock the reader is not looking at.
 * `one-card-law.test.ts` holds the whole directory to that.
 *
 * **No loading state, and no error state.** S1 rules both out and the shape
 * carries the ruling: there is no `pending` arm to render, because the card
 * renders synchronously from the fold, and a card that could be pending is a
 * card that could lie by omission. An unhandled condition is a typecheck
 * failure at the selector's own `_never` switch, not a state.
 *
 * **`vocabulary.ts` and not `disclosure.ts`, and it must stay that way.** This
 * file shipped once as `disclosure.ts` beside `Disclosure.tsx`, which broke
 * every test in this directory on macOS and would have broken prd-34's Windows
 * desktop app: a `'./disclosure.js'` specifier resolves across `./disclosure.ts`
 * and `./disclosure.tsx`, and on a case-insensitive filesystem the second one
 * matches `Disclosure.tsx` — the importing file — so the module resolves to
 * itself (#584). `case-collision-law.test.ts` now fails on any such pair
 * anywhere in the repo; renaming this back would trip it.
 */

/** The observed fact a why line rests on, and how old it is at the reading position. */
export interface Evidence {
  /**
   * What was actually observed — the clause that reads immediately before the
   * elapsed time. "the collector last answered", "last tool call was a file
   * read", "workmux reports waiting".
   */
  fact: string
  /**
   * Age of that observation in milliseconds, measured against the reader's own
   * position in time (now when live, the playhead in replay). Never read from
   * a clock inside this directory — see the module note.
   */
  elapsedMs: number
}

/**
 * One folded fact the condition was derived from — the events, counts and
 * timestamps behind the why (prd-30 S2, the teach affordance's *states*).
 *
 * It is the same shape as {@link Evidence} with a count, and deliberately so:
 * the teach layer expands the card's own why into the facts underneath it, in
 * the same register. A derivation whose entries read differently from the why
 * line above them would be S2's *"a teach layer that says something the card
 * does not"*.
 */
export interface Derivation {
  /** What was observed, in {@link Evidence.fact}'s register. */
  fact: string
  /**
   * How many times it was observed, where a count is meaningful. Omitted rather
   * than zero: "0 tool calls" is an absence, and an absence is a `fact` in its
   * own words ("no tool call since the session opened"), not a count of nothing.
   */
  count?: number
  /** Age of the observation at the reading position — the same clock rule as {@link Evidence.elapsedMs}. */
  elapsedMs: number
}

/** The reason, with the evidence that supports it. Neither half stands alone. */
export interface Why {
  /** The condition in one clause: "no data", "no output", "the fence is contended". */
  reason: string
  /** How the instrument knows, and how long ago it knew it. */
  evidence: Evidence
  /**
   * The folded facts the condition was derived from, for the teach affordance
   * to expand into (prd-30 ruling 3, S2).
   *
   * **Optional, and its absence is what withholds the affordance.** A selector
   * with nothing further to show hands back no derivation, and the card offers
   * no control — because a control that expands to nothing is the noise prd-30
   * is against, and #602 is the live example of what a surface looks like once
   * every mark explains itself whether or not it has anything to add.
   *
   * It is never a second explanation. These are the same facts the selector
   * already used, at more length.
   */
  derivedFrom?: readonly Derivation[]
}

/**
 * What the reader can do — or the stated fact that there is nothing, which is
 * a different claim from silence and has to read as one.
 */
export type Remedy =
  | {
      kind: 'action'
      /** The exact next action, in the imperative. */
      action: string
      /** The command that performs it, where one exists. Kept apart from the prose so a surface that can offer a copy affordance has something to copy. */
      command?: string
    }
  | {
      kind: 'none'
      /** Why there is nothing to do. Never blank: "nothing to do" without a reason is the silence this arm exists to prevent. */
      because: string
    }

/**
 * One condition, disclosed — prd-27 ruling 5's triple, and the whole vocabulary
 * of the instrument's explanations.
 *
 * `DisclosureContent` rather than `Disclosure` because `Disclosure` is the
 * component a caller wraps a mark in, and one name for two things is how a
 * reader ends up importing the wrong one. This is what the selector returns;
 * that is what renders it.
 */
export interface DisclosureContent {
  /** What is being disclosed — the same word the mark itself shows (S1's anatomy). */
  label: string
  why: Why
  remedy: Remedy
}

/**
 * The three strings, assembled once (prd-27 ruling 5's "assembled once so
 * every surface says a condition identically"). Every surface renders these
 * and composes none of its own.
 */
export interface DisclosureLines {
  label: string
  /** `<reason> — <fact> <elapsed> ago`. */
  why: string
  /** The action, or the stated reason there is none. */
  remedy: string
  /** The remedy's command, or null. Never folded into `remedy`: a surface that can copy needs it apart. */
  command: string | null
  /**
   * The teach layer's lines — `<fact> ×<count> — <elapsed> ago`, one per
   * derivation, in the order the selector listed them. **Empty when there is
   * nothing further to show**, which is how the card knows not to offer a
   * control.
   *
   * Assembled here rather than in the card for the reason the whole file
   * exists: S2's acceptance is *"a test asserts no string in the teach layer
   * exists outside the condition table"*, and the honest way to pass that is
   * for the teach layer to have no strings of its own to test — it renders
   * this array and composes nothing.
   */
  derivation: string[]
}

/**
 * A disclosure that cannot be rendered honestly. Thrown rather than rendered:
 * a card that degraded to a bare label on bad input would be the exact defect
 * the evidence requirement exists to forbid, only quieter.
 */
export class DisclosureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DisclosureError'
  }
}

/** Blank, whitespace-only or absent — the three ways a string arrives empty from a selector. */
function requireText(value: string, field: string, hint: string): string {
  // `String(… ?? '')` rather than `value.trim()`: the types say these are
  // strings, but the callers are selectors, and an `undefined` reaching here
  // should read as this error rather than as a TypeError from inside the card.
  const text = String(value ?? '').trim()
  if (text === '') throw new DisclosureError(`disclosure ${field} is empty — ${hint}`)
  return text
}

/**
 * An age, or the refusal. Shared by the why's evidence and by every derivation
 * line, because the teach layer relaxing a law the card enforces is precisely
 * how the beginner's depth becomes the dishonest one.
 */
function requireAge(elapsedMs: number, field: string): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new DisclosureError(
      `disclosure ${field} is not a measured age (${String(elapsedMs)}) — it is the reader's own position minus the observation, and a card cannot say how old a fact is without it`,
    )
  }
  return elapsedMs
}

/**
 * The teach lines, from the facts the selector already used. Nothing is
 * generated, nothing is summarised, and each line carries its own age — a
 * derivation that inherited the why's elapsed time would be asserting when it
 * did not observe.
 */
function derivationLines(derivedFrom: readonly Derivation[] | undefined): string[] {
  return (derivedFrom ?? []).map((row, index) => {
    const at = `why.derivedFrom[${index}]`
    // Same `??` idiom as the evidence guard above, for the same reason: a hole
    // in a selector's array should read as this directory's refusal, not as a
    // TypeError thrown from inside a card.
    const entry = row ?? { fact: '', elapsedMs: Number.NaN }
    const fact = requireText(
      entry.fact,
      `${at}.fact`,
      'the teach layer expands the facts the condition was derived from — an unnamed one teaches nothing',
    )
    const elapsedMs = requireAge(entry.elapsedMs, `${at}.elapsedMs`)

    const count = entry.count
    if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
      throw new DisclosureError(
        `disclosure ${at}.count is not a count of observations (${String(count)}) — omit it rather than render "×0", which reads as evidence and is an absence`,
      )
    }

    return `${fact}${count === undefined ? '' : ` ×${count}`} — ${formatSpan(elapsedMs)} ago`
  })
}

export function disclosureLines(disclosure: DisclosureContent): DisclosureLines {
  const label = requireText(disclosure.label, 'label', 'a card names what it is disclosing, in the same word the mark shows')

  const reason = requireText(
    disclosure.why.reason,
    'why.reason',
    'say what the condition is; a card with a label and no reason discloses nothing',
  )

  // The honest-gap law, and the reason this function exists at all: "no data"
  // is never acceptable on its own. `elapsedMs` is checked as hard as the
  // prose, because a NaN out of `now - null` renders "NaN ago" — evidence
  // shaped like evidence and worth nothing.
  //
  // The `??` is not dead code the types make impossible: an evidence-free why
  // reaching here from untyped JS should read as this directory's own refusal,
  // not as a TypeError thrown from inside a card.
  const evidence = disclosure.why.evidence ?? { fact: '', elapsedMs: Number.NaN }
  const fact = requireText(
    evidence.fact,
    'why.evidence.fact',
    `"${reason}" is a claim with nothing behind it — name what was observed ("the collector last answered"), never a bare gap`,
  )

  const elapsedMs = requireAge(evidence.elapsedMs, 'why.evidence.elapsedMs')

  const why = `${reason} — ${fact} ${formatSpan(elapsedMs)} ago`
  const derivation = derivationLines(disclosure.why.derivedFrom)

  switch (disclosure.remedy.kind) {
    case 'action': {
      const action = requireText(
        disclosure.remedy.action,
        'remedy.action',
        'name the next act; if there is none, say so with `kind: "none"` and a reason',
      )
      const command = disclosure.remedy.command
      return {
        label,
        why,
        remedy: action,
        command: command === undefined ? null : requireText(command, 'remedy.command', 'drop the field rather than offering an empty command'),
        derivation,
      }
    }
    case 'none': {
      const because = requireText(
        disclosure.remedy.because,
        'remedy.because',
        'a remedy of "none" states why there is nothing to do — otherwise it reads as an unwritten remedy',
      )
      return { label, why, remedy: because, command: null, derivation }
    }
    default: {
      const _never: never = disclosure.remedy
      throw new DisclosureError(`unreachable remedy: ${String(_never)}`)
    }
  }
}

/** What the honest unknown needs to know to stay honest. */
export interface UnknownDisclosureInput {
  /** The word the mark is showing — whatever the surface has on screen. */
  mark: string
  /** What the table would need in order to name it. */
  missing: string
  /** How old the evidence behind the mark is, at the reading position. The unknown card carries evidence like every other card. */
  elapsedMs: number
  /** The rung the instrument currently stands on. The rung above it is the one that would prove this. */
  at: Rung
  /**
   * The facts the instrument *does* hold about this mark, for the teach layer
   * (S2's *unknown* state: "expands to what is missing and which rung would
   * prove it — the same honest gap, at more length").
   *
   * Optional like every other derivation: an unknown with nothing folded behind
   * it offers no teach control rather than a control that expands to nothing.
   */
  derivedFrom?: readonly Derivation[]
}

/**
 * The *unknown* state (S1) — the condition is not in the table, so the card
 * **names what is missing and which rung would prove it** (prd-27 ruling 5's
 * clause, unchanged) rather than improvising warmth.
 *
 * It is a `Disclosure` like any other, which is the point: the unknown case
 * goes through the same three-part shape and the same evidence law, so it
 * cannot become the quiet arm where the requirements relax. The rung ladder is
 * `@rhizomorph/core`'s own (`rungInfo`, `nextRung`) rather than a second
 * vocabulary here — "which rung would prove it" is `nextRung(at)`, and how to
 * get there is `rungInfo(at).climb`.
 *
 * At `L4` there is no rung above, and the card says exactly that: the
 * instrument is at the top of the ladder and *still* cannot name the mark, so
 * the missing thing is the condition table itself and no amount of climbing
 * fixes it. That is a `none` remedy with a reason, not a cheerful suggestion.
 */
export function unknownDisclosure(input: UnknownDisclosureInput): DisclosureContent {
  const mark = requireText(input.mark, 'label', 'the unknown card still names the mark it could not explain')
  const missing = requireText(
    input.missing,
    'why.evidence.fact',
    'an unknown that cannot say what is missing is the improvisation this state exists to replace',
  )
  const above = nextRung(input.at)

  return {
    label: `unknown — ${mark}`,
    why: {
      reason: `no row in the condition table for ${mark}`,
      evidence: { fact: `${missing}, last evidence`, elapsedMs: input.elapsedMs },
      derivedFrom: input.derivedFrom,
    },
    remedy:
      above === null
        ? {
            kind: 'none',
            because: `already at ${rungInfo(input.at).label} — nothing further to climb, so what is missing is the condition table's own row, not the telemetry`,
          }
        : { kind: 'action', action: `${above} would prove it: ${rungInfo(input.at).climb}` },
  }
}
