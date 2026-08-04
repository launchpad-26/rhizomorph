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

// ── THE VIBRANCY DIALS (#157) — and the ceiling every one of them respects ───

/**
 * WHERE THE CALM WORLD'S HEADROOM WENT, in four numbers rather than in a sweep.
 *
 * The operator's review of the gorgeous round asked for "a LITTLE more vibrancy"
 * live, and the temptation is to take it from the one place it is cheapest: raise
 * `CALM_CEILING` and let the fleet climb. That would be the wrong trade and it is
 * worth saying why, because a future hand will be tempted the same way.
 *
 * Since prd4 dropped hue exclusivity, **the band between `CALM_CEILING` (0.78) and
 * `ALARM_FLOOR` (0.84) IS the salience mechanism** — it is the entire difference
 * between a green fleet and an amber summons. Six hundredths of luminance is all
 * an alarm has. Spending any of it on ambient prettiness would buy vibrancy with
 * the one property the instrument cannot lose, and law 9b would be *weakened*
 * rather than restated.
 *
 * So none of the numbers below moves a ceiling. Every one of them raises what the
 * calm world reaches **under** a ceiling that has not moved, in the two channels
 * the band does not own:
 *
 * - **chroma** ({@link ACTIVITY_TINT}, {@link TUFT_WASH}) — how much of its family
 *   a mark actually wears. `luminance()` is a weighted mean of the channels, so
 *   swinging a colour away from grey at constant mean costs the budget *nothing*
 *   and is the single largest visible gain available. A working thread now reads
 *   green rather than blue-grey-with-a-green-idea.
 * - **the floor** ({@link CALM_BODY_FLOOR}) — a quiet fleet is drawn from the
 *   bottom of the ramp, and the bottom is where "murky" lives. The ceiling binds
 *   for one lane in twenty; the floor binds for the other nineteen.
 *
 * `palette.test.ts` sweeps every activity at every freshness and heat through
 * `spend` and holds the pair to `CALM_CEILING`, so these dials cannot be turned
 * far enough to break the band even by accident.
 */

/**
 * How much of its family's hue a resting mark takes — the chroma dial.
 *
 * Raised across the board from prd4's values (working 0.45, waiting 0.50, done
 * 0.35). Still well below 1 for all of them, and that bound is the *original*
 * reason for the number rather than a leftover: a thread is a lit line with a
 * temperature, not a swatch, and twenty saturated cords would read as a bag of
 * colours instead of one picture. What moved is where inside that bound the calm
 * world sits — closer to its families, at the same luminance.
 *
 * `waiting` stays the highest of the three: benign amber is the state most easily
 * confused with a green at a glance, and hue is the channel that separates them.
 */
const ACTIVITY_TINT: Record<LaneActivity, number> = {
  working: 0.56,
  waiting: 0.6,
  done: 0.44,
  // Already ice. Tinting ice with ice would only round the numbers.
  idle: 0,
  unknown: 0,
}

/**
 * The alpha a living thread is drawn at with nothing going on at all — the floor
 * of {@link activityInk}'s ramp, and the number a *calm* fleet is actually made of.
 *
 * prd4 opened on "too dark and pale to read" and pinned the fix at 0.5 (up from a
 * regressed 0.22); `CALM_FLOOR` in `salience.ts` is what stops it drifting back
 * down. This raises it again, by the amount the ceiling leaves free: a maximally
 * fresh, maximally hot thread still lands over `CALM_CEILING` and is still held
 * there by `spend`, so the top of the band has not moved a hair — what has changed
 * is that the *bottom* of it is no longer nearly half transparent.
 */
export const CALM_BODY_FLOOR = 0.58

/**
 * How far an apical tuft is washed toward the ice ramp's white before its own
 * energy is added (prd10 ruling 4's "vivid family hue").
 *
 * Lowered from 0.25, and lowering it is what *raises* the vividness: `hotter()`
 * mixes toward {@link ICE_050}, so every hundredth of it is a hundredth of the
 * family's chroma traded for white. The apex is the one mark on a lane whose
 * brightness is not its age — it should look like the newest part of the organism,
 * which means more of the lane's colour and not more of the ramp's.
 *
 * The luminance it gives up doing so is given back in alpha (`marks/node.ts`), and
 * the pair still passes through `budget()` → `CALM_CEILING` like every other calm
 * mark. The amendment's own bounds (`TIP_CEILING`, `TIP_GLOW_RADIUS`, working tips
 * only, no fade exemption) are untouched: this dial cannot reach them, because it
 * is on the branchlets and the branchlets are not the glow.
 */
export const TUFT_WASH = 0.16

/**
 * THE ONE MODE MULTIPLIER (#157) — **live is a working instrument, replay is a
 * retrospective.**
 *
 * The scene is dimmed on purpose. Ambient depth, a fog at the rim, a vignette in
 * the corners and a substrate kept faint are all there for one reason: a live
 * instrument has to be *glanceable*, and a glanceable display spends nothing on
 * the periphery that the operator would have to consciously suppress. That
 * argument is about **live**. Nobody glances at a replay — they sit down and watch
 * it, deliberately, knowing it already happened. A performance of history has no
 * summons in it that anyone can answer, so the calm budget it is paying for buys
 * nothing, and the ambient dimming can relax.
 *
 * Hence one number, applied in exactly one place — `marks/ambient.ts` — and it is
 * worth being explicit about what it is **not** allowed to reach, because a mode
 * that could touch any of these would be a second vocabulary for facts the
 * instrument already has one for:
 *
 * - **never a status hue's meaning.** Green still means productive at whatever
 *   vibrancy. Law 9a is a property of `ACTIVITY_HUE`, and nothing here goes near it.
 * - **never the alarm grammar.** `CALM_CEILING`, `ALARM_FLOOR`, `TIP_CEILING`, the
 *   spotlight, the fade exemption, the cartouche: all untouched, in both modes.
 *   A replayed summons is exactly as far above its fleet as the live one was.
 * - **never the ladder.** Which lane is worst is the fleet's fact, not the
 *   transport's.
 * - **never the motion budget.** Not one period, amplitude or cap moves. A replay
 *   is *brighter*, not busier — `motion.test.ts` still owns every number that says
 *   how much the scene may move.
 *
 * What it does reach is the substrate: the spores and the rim flora are lit by it,
 * and the fog and the vignette are *relaxed* by it (`ambientVeil` — they are the
 * dimming, so the same number has to divide them rather than multiply). The rim
 * legibility law (`RIM_VEIL`) therefore comes out **stricter** in replay than live,
 * and `marks.test.ts` asserts it in both modes rather than only the one it was
 * written for.
 */
export const REPLAY_VIBRANCY = 1.4

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
 * A living lane's resting ink: its family's hue, at its own freshness and heat.
 *
 * Freshness — the same fact the node's distance from the mass carries — is read
 * a second time as lightness, because two channels saying the same thing is what
 * makes recency legible without a legend. The alpha floor is deliberately high
 * ({@link CALM_BODY_FLOOR} with nothing going on at all): the "too dark and pale
 * to read" complaint prd4 opens with was an alpha floor of 0.22, and `CALM_FLOOR`
 * in `salience.ts` pins the fix so it cannot be tuned back out.
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
  // The three terms still sum to over 1 at the top of the ramp, which is what
  // makes the ceiling the *budget's* job rather than this function's — see below.
  const alpha = CALM_BODY_FLOOR + 0.3 * fresh + 0.2 * warm

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
 * AWAY FROM ITS OWN GREY — the chroma channel, on its own.
 *
 * The exact complement of {@link hotter}, and the reason both exist: `hotter`
 * spends **luminance**, which is the channel the alarm band is denominated in and
 * therefore the expensive one. This spends **chroma**, which the band does not
 * measure at all — the pivot is the colour's own {@link luminance} weighting, so
 * the weighted mean is preserved exactly and `spend`'s cap sees the same number
 * before and after. That is what makes it the right dial for "more vibrancy
 * without touching the ceiling".
 *
 * `amount` is a gain, not a mix: 1 is unchanged, above 1 saturates, below 1 walks
 * toward grey. Hue survives (all three channels move on the same ray) and the
 * bytes are clamped, so a colour already at the edge of the gamut simply stops.
 */
export function saturate(rgb: Rgb, amount: number): Rgb {
  const grey = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return [byte(grey + (rgb[0] - grey) * amount), byte(grey + (rgb[1] - grey) * amount), byte(grey + (rgb[2] - grey) * amount)]
}

/**
 * AMBIENT LIGHT, AT THIS FRAME'S VIBRANCY (#157) — one of the two doors
 * {@link REPLAY_VIBRANCY} has, and the whole of what it does to a lit mark.
 *
 * Both channels the multiplier is permitted, and neither of the ones it is not:
 * luminance through alpha, chroma through {@link saturate}, and the hue itself
 * untouched. Only `marks/ambient.ts` calls this — a substrate mark carries no
 * fact by construction (its count is fixed and its positions are seeded), which
 * is exactly why it is the layer a mode is allowed to brighten.
 */
export function ambientLift(source: Ink, vibrancy: number): Ink {
  if (vibrancy === 1) return source
  return { rgb: saturate(source.rgb, vibrancy), alpha: clamp01(source.alpha * vibrancy) }
}

/**
 * AMBIENT DIMMING, RELAXED (#157) — the other door, and the reason the same
 * number has to divide here rather than multiply.
 *
 * The fog and the vignette are *negative* light: they are laid over the picture in
 * the void's own colours to push the rim away and keep the live scene calm. So
 * "the ambient dimming can relax" means less of them, and a multiplier applied
 * naively would have made a replay murkier while calling itself vibrancy. Colour
 * is untouched — a veil that saturated would be tinting the picture rather than
 * getting out of its way.
 *
 * Because it only ever *reduces* a veil, `RIM_VEIL` (the legibility bound on how
 * much of the rim the two washes may cover) comes out stricter in replay than in
 * live, never laxer.
 */
export function ambientVeil(source: Ink, vibrancy: number): Ink {
  if (vibrancy === 1) return source
  return { rgb: source.rgb, alpha: clamp01(source.alpha / Math.max(1, vibrancy)) }
}

/** Round into the byte range. Shared by {@link saturate}, which can overshoot it. */
function byte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
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
