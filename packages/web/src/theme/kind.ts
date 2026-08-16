/**
 * A KIND IS NOT A STATUS (prd-31 ruling 1) — the one module that says what a
 * kind looks like.
 *
 * **Status is the living thread.** Hue and brightness are spoken for: six
 * status hues, a calm band, an alarm band above it, and a glow grammar that
 * buys a summons its attention. A *kind* — a tool call, a file written, a
 * refusal, a subagent's turn — is not a state. It is what a row IS, not how
 * alarmed anyone should be about it, and it may never borrow the vocabulary
 * that answers the second question.
 *
 * **What a kind may carry:** lightness, and a capped category tint from the
 * tissue-derived family prd-32 ruling 8 defines as `--category-{1..4}`. Not a
 * status hue, not glow, and never above `CALM_CEILING`. The 0.06 between
 * `CALM_CEILING` (0.78) and `ALARM_FLOOR` (0.84) is the whole salience
 * mechanism that makes a death win the eye; a kind tint that climbed into it
 * would be stealing attention from an alarm while carrying no state at all.
 * This module does not restate those caps — `theme/category.ts` owns them and
 * `theme/category.test.ts` proves each one bites. `kind.test.ts` feeds the
 * tints *this* module actually spends straight into `capViolations`, so a tint
 * lifted over the ceiling here turns the same law red.
 *
 * Ruling 1 originally read "lightness only, never hue". It was rewritten before
 * anything was built against it, and the reason is worth keeping: lightness
 * alone separates roughly three levels before a reader stops perceiving the
 * difference, and a conversation is a wall of undifferentiated text today. A
 * bounded tint separates kinds at a glance without spending anything the status
 * vocabulary owns — which is exactly the trade the five caps exist to police.
 *
 * **Why this file exists at all.** The sentence above was encoded three times,
 * in three files, uncoordinated: `trace/glyphs.tsx`'s `KIND_CLASS`,
 * `drawer/Activity.tsx`'s `KIND_CLASS`, and `drawer/Conversation.tsx` inline.
 * Three copies agreed today and would not have agreed after the fourth surface
 * — they already disagreed on `tool`, which was `ice-400` in the trace and
 * `ice-300` in the ledger. The plurality is the defect, and `kind.test.ts`
 * greps the tree so a fourth copy fails by diff.
 *
 * **Why `theme/` and not `trace/`.** The three consumers span two directories,
 * so the module cannot live inside either without one surface importing
 * appearance from the other's folder. It sits beside `category.ts`, whose caps
 * it consumes and whose family it spends — one directory owns colour law. And
 * `trace/`'s furniture is being read right now by prd-28 wave 3 (#439): adding
 * a file there is exactly the kind of ground-shift the fence calendar exists to
 * prevent.
 *
 * No JSX and no React here on purpose — this is a table plus the law that
 * checks it, so the law can be rigged from a plain test without a renderer.
 */

/**
 * The four categories, and nothing beyond them. Bounded is half of ruling 8:
 * a family that grows is a palette, and a palette beside six status hues is
 * the thing "no new semantic hue" was protecting.
 */
export type WorkCategory = 'speech' | 'gate' | 'tool' | 'change'

/**
 * Every kind any surface in this app renders, in one vocabulary.
 *
 * Deliberately *not* any one surface's enum: the trace speaks `SpanKind`, the
 * activity ledger speaks `ActivityKind`, and a transcript speaks block kinds.
 * Each translates into this list at its own edge — that translation is
 * vocabulary, not appearance, so it stays with the surface that owns the
 * vocabulary. What may never live out there is a class.
 */
export type WorkKind =
  | 'run'
  | 'model'
  | 'tool'
  | 'exec'
  | 'result'
  | 'blocked'
  | 'hook'
  | 'file'
  | 'commit'
  | 'other'

/** The family's four token names. The *values* stay in `theme.css`; this is a citation. */
export type CategoryToken = '--category-1' | '--category-2' | '--category-3' | '--category-4'

/**
 * Category → tint, ordered by consequence rather than by frequency.
 *
 * The ramp runs from the kind that *fills* a surface to the kind that changes
 * the world: speech is most of every transcript and gets the quietest
 * material, while a file written or a commit landed is rare and gets the loud
 * end. That inverts the usual instinct (give the main reading the strongest
 * treatment) on purpose — a tint that every third line wears is not a
 * distinction, it is a background.
 *
 * "Loud" is relative to the family, which is the point of cap 3: the brightest
 * member measures 0.661 against a `CALM_CEILING` of 0.78, so the loudest kind
 * in the app is still quieter than the quietest alarm.
 */
export const CATEGORY_TINT: Record<WorkCategory, CategoryToken> = {
  speech: '--category-1',
  gate: '--category-2',
  tool: '--category-3',
  change: '--category-4',
}

/**
 * The tint as a rule down the row's left edge — material, never ink.
 *
 * Two reasons it is an edge and not a text colour. The family is a *ramp*, so
 * its dark half (`--category-1` at 1.98:1 on the page floor, `--category-2` at
 * 3.31:1) cannot legally carry text under prd9's legibility floor — spending
 * it as ink would mean spending only the top two members, and a bounded family
 * half-used is a family that will grow. And it is the reading D24 already
 * settled for the scene: status is the living thread, category is its
 * *material* — sheath, nodes, banding. A rule beside a word is banding.
 *
 * Written as whole literals rather than assembled from parts because Tailwind
 * finds classes by scanning source text; a class built by concatenation is a
 * class that generates no CSS. `border-(--token)` is the v4 shorthand that
 * compiles to a `border-color` of that variable — verified in the built sheet,
 * because a mis-spelled arbitrary property does not error, it silently emits
 * nothing. And `--category-*` is deliberately not spelled `--color-category-*`
 * upstream, so no `bg-category-3` utility exists to be reached for by a name
 * shaped like a status colour.
 */
export const CATEGORY_EDGE: Record<WorkCategory, string> = {
  speech: 'border-(--category-1)',
  gate: 'border-(--category-2)',
  tool: 'border-(--category-3)',
  change: 'border-(--category-4)',
}

/**
 * What an uncategorised kind wears instead. `other` is the trace's honest
 * "the mapping did not recognise this" bucket — it is not a fifth category and
 * must not look like one, but it still holds the column, or every row above and
 * below it would shift by two pixels around an unknown span.
 */
export const NO_EDGE = 'border-transparent'

export interface KindAppearance {
  /** The tag word — one short lowercase noun, rendered uppercase by the tag. */
  readonly word: string
  /** Accessible name, for a row whose only visible label is the tag. */
  readonly label: string
  /** Which of the four this kind belongs to, or `null` for lightness alone. */
  readonly category: WorkCategory | null
  /** Lightness. One ice step, never dimmer than the `ice-400` text floor. */
  readonly ink: string
  /** The category tint, as a border colour. Never a fill and never ink. */
  readonly edge: string
}

/**
 * THE TABLE. One row per kind, and the only place in the tree where a kind and
 * a class name appear in the same expression.
 *
 * Lightness still does the primary work — the tint is reinforcement, not the
 * carrier, because law 9 holds and colour is never the sole signal. Read the
 * `ink` column alone and the kinds still sort: what a lane is doing now
 * (`ice-300`), what it produced (`ice-200`), and the machinery underneath
 * (`ice-400`).
 */
export const KIND_APPEARANCE: Record<WorkKind, KindAppearance> = {
  /** A whole exchange — one prompt and everything it caused. */
  run: { word: 'run', label: 'interaction', category: 'speech', ink: 'text-ice-300', edge: CATEGORY_EDGE.speech },
  /** A request to a model. The conversation's other half, so: speech. */
  model: { word: 'llm', label: 'model request', category: 'speech', ink: 'text-ice-200', edge: CATEGORY_EDGE.speech },
  /** A tool call. `ice-300` settles the old disagreement in the ledger's favour. */
  tool: { word: 'tool', label: 'tool call', category: 'tool', ink: 'text-ice-300', edge: CATEGORY_EDGE.tool },
  /** The call actually running — machinery under the call, so a step dimmer. */
  exec: { word: 'exec', label: 'tool execution', category: 'tool', ink: 'text-ice-400', edge: CATEGORY_EDGE.tool },
  /** What the tool said back. */
  result: { word: 'result', label: 'tool result', category: 'tool', ink: 'text-ice-400', edge: CATEGORY_EDGE.tool },
  /**
   * The run stopped on a human. Retrospective-exact (prd9 ruling 6): it reports
   * how long a lane SAT waiting, never that anyone is waiting now — which is
   * precisely why it is a kind and not the amber that means "a human must act".
   */
  blocked: { word: 'blocked', label: 'blocked on a human', category: 'gate', ink: 'text-ice-300', edge: CATEGORY_EDGE.gate },
  /** The run stopped on a policy. Same shape as `blocked`, different gatekeeper. */
  hook: { word: 'hook', label: 'hook span', category: 'gate', ink: 'text-ice-400', edge: CATEGORY_EDGE.gate },
  /** A file the lane changed — the first half of the evidence the transcript cannot give. */
  file: { word: 'file', label: 'file change', category: 'change', ink: 'text-ice-400', edge: CATEGORY_EDGE.change },
  /** A commit it landed — the second half, and the loudest kind in the app. */
  commit: { word: 'commit', label: 'commit', category: 'change', ink: 'text-ice-200', edge: CATEGORY_EDGE.change },
  /** Unrecognised. Never dropped and never an error — and never a category. */
  other: { word: 'other', label: 'unclassified span', category: null, ink: 'text-ice-400', edge: NO_EDGE },
}

/** Every kind, for exhaustive walks. Derived, so it cannot fall behind the table. */
export const WORK_KINDS = Object.keys(KIND_APPEARANCE) as readonly WorkKind[]

/**
 * The fixed-width kind tag, whole. Both ledgers spelled these six utilities
 * identically before this module existed, which is the tell that the tag — not
 * just its colour — is one shared thing.
 *
 * `border-l-2 pl-1.5` is unconditional so the word column starts at the same x
 * whether or not the kind has a category; `NO_EDGE` holds the space. The column
 * goes `w-14` → `w-16` to pay for the rule and its gutter — the box is
 * border-box, so keeping 3.5rem would have taken 8px out of the word and clipped
 * the longest one (`blocked`).
 */
export function kindTagClass(kind: WorkKind): string {
  const { ink, edge } = KIND_APPEARANCE[kind]
  return `w-16 shrink-0 border-l-2 pl-1.5 text-[10px] uppercase tracking-wider ${ink} ${edge}`
}

/**
 * The tint alone, as a left rule, for a surface that has no tag column — the
 * transcript, where a tool call is a line of prose-width mono rather than a row
 * in a table.
 */
export function kindEdgeClass(kind: WorkKind): string {
  return `border-l-2 pl-1.5 ${KIND_APPEARANCE[kind].edge}`
}

/** The ink alone, for the same reason. */
export function kindInkClass(kind: WorkKind): string {
  return KIND_APPEARANCE[kind].ink
}

/**
 * The world the law is measured against — the parts that are not the kind
 * table. Passed in rather than imported so `kind.test.ts` can hand the law a
 * deliberately illegal table and watch the right clause fail.
 */
export interface KindWorld {
  /**
   * The six status hue tokens, as they are declared in `theme.css`
   * (`--color-needs-you`, …). Read off the sheet by the test rather than
   * restated here: a short list would make the law generous by accident.
   */
  readonly statusTokens: readonly string[]
  /**
   * The ice steps text may legally wear — prd9's legibility floor. `ice-500`
   * and dimmer measure below WCAG's 4.5:1 against the page floor and are
   * structure tokens, never text.
   */
  readonly inkAllowed: readonly string[]
}

/**
 * Every way the table breaks the law, as sentences a reader can act on. Empty
 * is the only passing answer.
 *
 * Returned rather than asserted, for the reason `capViolations` gives: a
 * boolean would let a table that breaks two clauses pass a test that only meant
 * to prove one of them bites.
 */
export function kindLawViolations(
  table: Record<string, KindAppearance>,
  world: KindWorld,
): string[] {
  const broken: string[] = []

  for (const [kind, look] of Object.entries(table)) {
    const classes = `${look.ink} ${look.edge}`

    // A KIND IS NOT A STATUS. Both spellings of the offence: a generated
    // utility (`text-needs-you`, `border-broken`) and a raw reach for the token
    // itself (`text-(--color-broken)`). The second is the one a law that only
    // read utility names would miss.
    for (const token of world.statusTokens) {
      const stem = token.replace(/^--color-/, '')
      if (new RegExp(`\\b(?:text|bg|border|ring|fill|stroke|decoration|outline)-${stem}\\b`).test(classes)) {
        broken.push(`a kind is not a status: ${kind} wears \`${stem}\`, a status hue`)
      }
      if (classes.includes(token)) {
        broken.push(`a kind is not a status: ${kind} reaches for \`${token}\` directly`)
      }
    }

    // Glow is alarm grammar (law 9b, cap 2). A kind with a halo would be
    // borrowing the one treatment reserved for "a human must act".
    if (/\bglow-/.test(classes)) {
      broken.push(`no glow: ${kind} wears \`${classes}\`, and a halo is alarm grammar`)
    }

    // Lightness is the primary carrier, so it has to be readable.
    if (!world.inkAllowed.includes(look.ink)) {
      broken.push(
        `legibility floor: ${kind}'s ink is \`${look.ink}\`, which is not one of ${world.inkAllowed.join(', ')}`,
      )
    }

    // The tint comes from the bounded family or the kind has none at all —
    // there is no third option, and no surface may invent a fifth member.
    const expected = look.category === null ? NO_EDGE : CATEGORY_EDGE[look.category]
    if (look.edge !== expected) {
      broken.push(
        `bounded family: ${kind} is category \`${look.category ?? 'none'}\` but its edge is \`${look.edge}\`, not \`${expected}\``,
      )
    }
  }

  return broken
}
