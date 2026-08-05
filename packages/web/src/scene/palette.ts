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
 * The band between `CALM_CEILING` (0.78) and `ALARM_FLOOR` (0.84) is the whole
 * of the salience mechanism (law 9b) — never raise `CALM_CEILING` to buy
 * vibrancy. The dials below raise only chroma ({@link ACTIVITY_TINT},
 * {@link TUFT_WASH}) and the floor ({@link CALM_BODY_FLOOR}), which the band
 * does not own. `palette.test.ts` sweeps every activity/freshness/heat through
 * `spend` and holds the pair to `CALM_CEILING`.
 *
 * See docs/decisions/palette-vibrancy-dials.md for why and by how much.
 */

/**
 * How much of its family's hue a resting mark takes — the chroma dial. Must
 * stay well below 1 for all three: a thread is a lit line with a temperature,
 * not a swatch, and twenty saturated cords would read as a bag of colours
 * instead of one picture. `waiting` stays the highest: benign amber is the
 * state most easily confused with a green at a glance, and hue is the channel
 * that separates them. See docs/decisions/palette-vibrancy-dials.md.
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
 * `CALM_FLOOR` in `salience.ts` is the hard lower bound this must stay above.
 * Raising this dial never moves the ceiling: a maximally fresh, maximally hot
 * thread still lands over `CALM_CEILING` and is still held there by `spend`.
 * See docs/decisions/palette-vibrancy-dials.md.
 */
export const CALM_BODY_FLOOR = 0.58

/**
 * How far an apical tuft is washed toward the ice ramp's white before its own
 * energy is added (prd10 ruling 4's "vivid family hue"). `hotter()` mixes
 * toward {@link ICE_050}, so every hundredth of this is a hundredth of the
 * family's chroma traded for white — the apex should look like the newest
 * part of the organism, which means more of the lane's colour, not the ramp's.
 * This dial is on the branchlets and must never reach the glow amendment's own
 * bounds (`TIP_CEILING`, `TIP_GLOW_RADIUS`, working tips only, no fade
 * exemption in `marks/node.ts`) — the branchlets are not the glow.
 * See docs/decisions/palette-vibrancy-dials.md.
 */
export const TUFT_WASH = 0.16

/**
 * The one substrate-vibrancy multiplier for replay mode, applied in exactly one
 * place (`marks/ambient.ts`). It must never reach: a status hue's meaning (law
 * 9a, `ACTIVITY_HUE`), the alarm grammar (`CALM_CEILING`, `ALARM_FLOOR`,
 * `TIP_CEILING`, spotlight, fade exemption, cartouche), the ladder, or the motion
 * budget (`motion.test.ts` owns every number there — replay is brighter, not
 * busier). It reaches only the substrate: it lights the spores and rim flora,
 * and *relaxes* the fog/vignette via `ambientVeil` (they are dimming, so the
 * same number divides them rather than multiplying) — which means the rim
 * legibility law (`RIM_VEIL`) comes out stricter in replay than live, and
 * `marks.test.ts` asserts it in both modes.
 *
 * See docs/decisions/palette-vibrancy-dials.md for why 1.6 and not a more
 * obvious 1.2, and for the tension with ruling 16 this number deliberately
 * doesn't resolve.
 */
export const REPLAY_VIBRANCY = 1.6

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
 * ice, and the only one whose permission is written as a *place* rather than a
 * meaning: organic tissue only (heart depths, thread underglow, spore motes, the
 * cooling gradient in {@link returningInk}). Never a status, never data ink,
 * never chrome. Its OKLCH hue (295.5, low chroma) must stay 41° clear of the ice
 * ramp, 87° from notice-cyan and 78° from broken-red — `palette.test.ts` measures
 * all three — and the whole ramp must stay below the text-contrast floor, since
 * tissue is never ink. See docs/decisions/palette-tissue-accent.md.
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
 * A returning mote's colour at `t` of its journey home (ruling 12): born in the
 * lane's own done-family colour, cooling through the tissue ramp as it travels.
 * The only place a status hue and the accent are allowed to touch. Entered from
 * the ramp's light end and travelled downward — a mote must arrive at the heart
 * as one of the ramp's own dark depths, not a bright violet dot laid on top of
 * them. See docs/decisions/palette-tissue-accent.md.
 */
export function returningInk(family: Rgb, journey: number, luminance: number): Ink {
  const t = clamp01(journey)
  // The hand-off is early and soft: a mote is unmistakably its lane's colour for
  // the first third, and unmistakably tissue by the last.
  const cooled = mix(family, tissueAt(1 - t), Math.min(1, t * 1.4))
  return ink(cooled, clamp01(luminance))
}

/**
 * The one place a lane's activity becomes a colour — `marks/` must never name a
 * hue for a state itself, only ask here, or "green means productive" stops being
 * a property of the instrument. Idle and unknown stay ice on purpose: a lane the
 * log has never mentioned must not be able to borrow the confidence a hue would
 * lend it (law 12's gap honesty, kept on brightness alone).
 */
export const ACTIVITY_HUE: Record<LaneActivity, Rgb> = {
  working: WORKING,
  // The benign end of the amber family (law 9a) — NEEDS_YOU is its incandescent end.
  waiting: WAITING_BENIGN,
  done: DONE,
  idle: ICE_400,
  unknown: ICE_600,
}

/**
 * A living lane's resting ink: its family's hue, at its own freshness and heat.
 * Freshness is read a second time as lightness (the node's distance from the
 * mass carries the same fact), so recency reads without a legend. The alpha
 * floor must never drop below `CALM_FLOOR` (`salience.ts`). `done` is scaled
 * down rather than up — it must stay legible as the same green as `working`,
 * but shouting as loud as a running lane would make a landed fleet look busy.
 * The floor is this function's promise; the ceiling is not — a maximally
 * fresh, maximally hot green does reach past `CALM_CEILING` here, and
 * `salience.spend` holding it down is the mechanism, not a leak.
 */
export function activityInk(activity: LaneActivity, freshness: number, heat: number): Ink {
  const fresh = clamp01(freshness)
  const warm = clamp01(heat)
  const resting = mix(ICE_500, ICE_100, fresh)
  // Sums to over 1 at the top of the ramp on purpose — the ceiling is the budget's job.
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
 * The chroma channel, on its own — the exact complement of {@link hotter}.
 * `hotter` spends luminance, which the alarm band is denominated in and is
 * therefore expensive; this spends chroma, which the band does not measure at
 * all, because the pivot is the colour's own {@link luminance} weighting — the
 * weighted mean is preserved exactly, so `spend`'s cap sees the same number
 * before and after. `amount` is a gain, not a mix: 1 is unchanged, above 1
 * saturates, below 1 walks toward grey; hue survives because all three
 * channels move on the same ray.
 */
export function saturate(rgb: Rgb, amount: number): Rgb {
  const grey = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return [byte(grey + (rgb[0] - grey) * amount), byte(grey + (rgb[1] - grey) * amount), byte(grey + (rgb[2] - grey) * amount)]
}

/**
 * Ambient light at this frame's vibrancy — the whole of what
 * {@link REPLAY_VIBRANCY} may do to a lit mark: luminance through alpha,
 * chroma through {@link saturate}, hue always untouched. Only
 * `marks/ambient.ts` may call this — a substrate mark carries no fact by
 * construction (fixed count, seeded positions), which is why it's the one
 * layer a mode is allowed to brighten.
 */
export function ambientLift(source: Ink, vibrancy: number): Ink {
  if (vibrancy === 1) return source
  return { rgb: saturate(source.rgb, vibrancy), alpha: clamp01(source.alpha * vibrancy) }
}

/**
 * Ambient dimming, relaxed — must divide here rather than multiply. The fog
 * and vignette are negative light laid over the picture to keep the live
 * scene calm, so relaxing them means *less* of them; a naive multiply would
 * make a replay murkier while calling itself vibrancy. Colour stays untouched
 * — a veil that saturated would be tinting the picture, not getting out of
 * its way. Because this only ever reduces a veil, `RIM_VEIL` comes out
 * stricter in replay than live, never laxer.
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
 * The incandescent end of a family — how a summons clears `ALARM_FLOOR` above
 * the calm ceiling (law 9b): {@link NEEDS_YOU} at full alpha is only ~0.80
 * bright, not enough daylight over a green fleet at 0.78. Deliberately one
 * number rather than a per-mark tuning, since a law with five dials is a
 * suggestion. {@link BROKEN} is exempt — see `ALARM_FLOOR` in `salience.ts`.
 */
export function incandescent(rgb: Rgb): Rgb {
  return hotter(rgb, 0.45)
}

/** Perceived brightness, 0–1, alpha included — the number the contrast budget in `salience.ts` is spent in. */
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
