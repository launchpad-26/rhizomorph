import type { LaneActivity } from '../fleet/buildFleet.js'

/**
 * The scene's ink — the ice-neon register (prd4 ruling 3) as canvas numbers.
 *
 * Canvas cannot read a Tailwind class, so these are the one place in the
 * instrument where a theme token is repeated as a literal. `palette.test.ts`
 * parses `theme/theme.css` and asserts every constant here still equals its
 * token, so the mirror cannot drift silently.
 *
 * Three laws are carried by the numbers themselves:
 *
 * - **Hue is meaning, and each hue means one thing** (law 9a). Green is
 *   productive, amber is blocked on a human, red is dead, cyan is a notice, and
 *   ice is structure and nothing-to-say. The activity states and the alarm rungs
 *   are one scale, not two vocabularies: {@link WORKING} and {@link DONE} are
 *   the same green at two brightnesses, {@link WAITING_BENIGN} and
 *   {@link NEEDS_YOU} the same amber. {@link ACTIVITY_HUE} is the only place a
 *   lane's activity becomes a colour, which is what keeps `marks/` free of
 *   magic hexes.
 * - **The brightness band owns attention, not hue exclusivity** (law 9b). A
 *   calm mark may wear its family's hue; what it may not do is reach the
 *   luminance above `CALM_CEILING`, wear a glow or a cartouche, or skip a fade.
 *   `salience.ts` is where that band is enforced.
 * - **Neon is luminance, not saturation** (ruling 29's surviving half).
 *   "White-hot" for an expensive thread is therefore lawful: it is
 *   {@link ICE_050}, the ramp's ceiling, not a hue. Nothing in this file reaches
 *   for `#ffffff` — the scene's white is the ice register's white, which is why
 *   a blown-out thread still belongs to the same world as the chrome.
 */

export type Rgb = readonly [number, number, number]

/** A colour and how much of it. Kept unstringified so brightness stays comparable. */
export interface Ink {
  readonly rgb: Rgb
  readonly alpha: number
}

// ── the ice ramp: the calm world ────────────────────────────────────────────

/** The void the network hangs in. */
export const ICE_1000: Rgb = [4, 6, 12]
/** The chip behind a spotlit label — the panel surface, borrowed. */
export const ICE_950: Rgb = [8, 11, 20]
/** A thread whose lane has drifted cold. The floor of the thread ramp. */
export const ICE_700: Rgb = [38, 51, 77]
/** UNKNOWN: the quietest legible ink. A lane the log has said nothing about. */
export const ICE_600: Rgb = [54, 71, 104]
/** The floor of the *living* thread ramp — an old thread, still clearly drawn. */
export const ICE_500: Rgb = [76, 98, 137]
/** IDLE, and the secondary label ink. */
export const ICE_400: Rgb = [106, 129, 168]
/** Body copy: lane names, figures, the gap voice. */
export const ICE_300: Rgb = [142, 163, 196]
/** Primary data ink. The calm neon. */
export const ICE_200: Rgb = [179, 198, 222]
/** Emphasis — the ceiling of the resting thread ramp, at full freshness. */
export const ICE_100: Rgb = [214, 226, 242]
/** Peak luminance. Pulses, the root-mass core, a white-hot thread. */
export const ICE_050: Rgb = [240, 245, 252]

// ── the semantic map: six hues, each meaning one thing (law 9a) ─────────────

/** WORKING — the green family's live end. The lane is getting on with it. */
export const WORKING: Rgb = [64, 217, 140]
/** DONE — the same green, dimmer. It got on with it and stopped. */
export const DONE: Rgb = [46, 157, 116]
/** WAITING-BENIGN — the amber family's muted end. Stopped; nobody summoned. */
export const WAITING_BENIGN: Rgb = [217, 164, 65]
/** NEEDS-YOU — the amber family's incandescent end. A human must act. */
export const NEEDS_YOU: Rgb = [255, 200, 87]
/** BROKEN — dead air. FROZEN's cut strokes and hollow node, and nothing else. */
export const BROKEN: Rgb = [255, 61, 104]
/** NOTICE — something changed; nobody is needed. EXPENSIVE's chevrons only. */
export const NOTICE: Rgb = [77, 234, 255]

/**
 * Dead tissue: a frozen lane's *thread*, while its marks keep the broken hue.
 * The corpse is grey, the alarm is red. A luminance, not a seventh hue.
 */
export const NECROTIC: Rgb = [74, 82, 102]

// ── living tissue: the one accent (prd10 rulings 5, 11, 12) ─────────────────

/**
 * THE TISSUE RAMP — the only hue in the instrument that is not a status and not
 * ice, and the only one whose permission is written as a *place* rather than as
 * a meaning.
 *
 * Ruling 29 bought salience by forbidding the calm world colour; prd4 replaced
 * that with the brightness band, and prd10 ruling 5 opens the one remaining door
 * a hair: a cold bioluminal violet, for **organic tissue only**. The heart's
 * depths, the thread's underglow, spore motes, and the gradient a severed lane's
 * matter cools through on its way home (ruling 12). Never a status, never data
 * ink, never chrome.
 *
 * Why it is safe, in numbers rather than in assurances (ruling 11): H 295.5 in
 * OKLCH, at low chroma — 41° clear of the ice ramp, 87° from notice-cyan, 78°
 * from broken-red. `palette.test.ts` measures all three, so the accent cannot
 * drift toward a hue that already means something. And the whole ramp sits below
 * the text-contrast floor by design: tissue is not ink, so prd4's legibility law
 * is untouched rather than traded against.
 */
export const TISSUE_900: Rgb = [30, 24, 51]
export const TISSUE_700: Rgb = [50, 39, 82]
export const TISSUE_500: Rgb = [75, 58, 122]
/** THE ACCENT itself (ruling 11) — `#6b4fa8`. */
export const TISSUE_400: Rgb = [107, 79, 168]
export const TISSUE_200: Rgb = [143, 111, 214]

/**
 * The ramp in order, dark to light. Read as a *gradient* rather than as five
 * choices: {@link tissueAt} is the only way anything in the scene reaches for a
 * step, which is what keeps the accent one continuous material instead of five
 * swatches somebody picked between.
 */
export const TISSUE_RAMP: readonly Rgb[] = [
  TISSUE_900,
  TISSUE_700,
  TISSUE_500,
  TISSUE_400,
  TISSUE_200,
]

/** Sample the tissue ramp, 0 = its deepest step and 1 = its lightest. */
export function tissueAt(t: number): Rgb {
  const last = TISSUE_RAMP.length - 1
  const on = clamp01(t) * last
  const i = Math.min(last - 1, Math.floor(on))
  return mix(TISSUE_RAMP[i] as Rgb, TISSUE_RAMP[i + 1] as Rgb, on - i)
}

/**
 * RULING 12, AS ONE FUNCTION — a returning mote's colour at `t` of its journey.
 *
 * Born in the lane's own dim done-family colour (it *is* the lane's substance,
 * so status meaning is preserved at the cut) and cooling through the tissue ramp
 * as it drifts home (tissue meaning at the heart). The composting story told in
 * colour, and the only place in the instrument where a status hue and the accent
 * are allowed to touch: along this gradient and nowhere else.
 *
 * The ramp is entered from its light end and travelled downward, because that is
 * what "cooling" means — a mote arrives at the heart as one of its own dark
 * depths rather than as a bright violet dot laid on top of them.
 */
export function returningInk(family: Rgb, journey: number, luminance: number): Ink {
  const t = clamp01(journey)
  // The hand-off is early and soft: a mote is unmistakably its lane's colour for
  // the first third, and unmistakably tissue by the last.
  const cooled = mix(family, tissueAt(1 - t), Math.min(1, t * 1.4))
  return ink(cooled, clamp01(luminance))
}

/**
 * THE CHOKEPOINT — the one place a lane's activity becomes a colour.
 *
 * `marks/` never names a hue for a state; it asks here. That is what makes
 * "green means productive" a property of the instrument rather than a habit of
 * whoever wrote the last mark, and it is why re-aiming the whole scene at a new
 * semantic map is an edit to this record and not a sweep through five files.
 *
 * Idle and unknown are ice on purpose: nothing-to-say is structure, and a lane
 * the log has never mentioned must not be able to borrow the confidence a hue
 * would lend it (law 12's gap honesty, kept on brightness alone).
 */
export const ACTIVITY_HUE: Record<LaneActivity, Rgb> = {
  working: WORKING,
  // The benign end of the amber family. The *pathology* called `waiting` — a
  // lane stopped long enough to need somebody — is NEEDS_YOU, its incandescent
  // end; the two are one scale read at two brightnesses (law 9a).
  waiting: WAITING_BENIGN,
  done: DONE,
  idle: ICE_400,
  unknown: ICE_600,
}

/**
 * How much of its family's hue a resting mark takes. Below 1 for all of them:
 * a thread is a lit *line* with a temperature, not a swatch, so the hue is
 * mixed into the ice ramp rather than replacing it — which is also what keeps
 * a twenty-lane fleet reading as one picture instead of a bag of colours.
 */
const ACTIVITY_TINT: Record<LaneActivity, number> = {
  working: 0.45,
  waiting: 0.5,
  done: 0.35,
  // Already ice. Tinting ice with ice would only round the numbers.
  idle: 0,
  unknown: 0,
}

/**
 * A living lane's resting ink: its family's hue, at its own freshness and heat.
 *
 * Freshness — the same fact the node's distance from the mass carries — is read
 * a second time as lightness, because two channels saying the same thing is what
 * makes recency legible without a legend. The alpha floor is deliberately high
 * (0.5 with nothing going on at all): the "too dark and pale to read" complaint
 * prd4 opens with was an alpha floor of 0.22, and `CALM_FLOOR` in `salience.ts`
 * pins the fix so it cannot be tuned back out.
 *
 * `done` is the one state scaled down rather than up. It is the same green as
 * `working` and must stay legible, but a finished lane that shouted as loudly as
 * a running one would make a landed fleet look like a busy one.
 *
 * The floor is this function's promise; the ceiling is not. A maximally fresh,
 * maximally hot green does reach past `CALM_CEILING` here — `salience.spend` is
 * what holds it down, and holding it down is the mechanism rather than a leak.
 */
export function activityInk(activity: LaneActivity, freshness: number, heat: number): Ink {
  const fresh = clamp01(freshness)
  const warm = clamp01(heat)
  const resting = mix(ICE_500, ICE_100, fresh)
  const alpha = 0.5 + 0.3 * fresh + 0.2 * warm

  return ink(
    mix(resting, ACTIVITY_HUE[activity], ACTIVITY_TINT[activity]),
    activity === 'done' ? alpha * 0.85 : alpha,
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function ink(rgb: Rgb, alpha: number): Ink {
  return { rgb, alpha: clamp01(alpha) }
}

export function fade(source: Ink, factor: number): Ink {
  return { rgb: source.rgb, alpha: clamp01(source.alpha * factor) }
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t)
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

/**
 * Toward the ice register's ceiling — how anything in this scene runs hot
 * without acquiring a hue. The target is {@link ICE_050} rather than pure white
 * on purpose: the brightest thing on screen still belongs to the palette.
 */
export function hotter(rgb: Rgb, amount: number): Rgb {
  return mix(rgb, ICE_050, amount)
}

/**
 * The incandescent end of a family — how a summons reaches the band above the
 * calm ceiling (law 9b). {@link NEEDS_YOU} at full alpha is only ~0.80 bright,
 * which is not enough daylight over a green fleet at 0.78, so the marks that
 * *are* the summons (a knot's ring, a raised hand's palm, a held pulse, the
 * orbiting light, an off-fence barb) are run this far toward the ramp's white.
 *
 * Deliberately one number rather than a per-mark tuning: `ALARM_FLOOR` is a law,
 * and a law with five dials is a suggestion. {@link BROKEN} is exempt — see the
 * note on `ALARM_FLOOR` in `salience.ts` for why red buys its supremacy a
 * different way.
 */
export function incandescent(rgb: Rgb): Rgb {
  return hotter(rgb, 0.45)
}

/**
 * Perceived brightness, 0–1, alpha included. This is the number the contrast
 * budget is spent in (`salience.ts`) and the number graft g6's test compares, so
 * "the white-hot lane must not outshine the summons" is one arithmetic
 * assertion rather than a judgement about two screenshots.
 */
export function luminance(value: Ink): number {
  const [r, g, b] = value.rgb
  return ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * value.alpha
}

export function cssColour(value: Ink): string {
  const [r, g, b] = value.rgb
  return `rgba(${r}, ${g}, ${b}, ${clamp01(value.alpha).toFixed(3)})`
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
