import type { LadderRank, LaneActivity } from '@rhizomorph/core'

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
 * See docs/design-notes/palette-vibrancy-dials.md for why and by how much.
 */

/**
 * How much of its family's hue a resting mark takes — the chroma dial. Must
 * stay well below 1 for all three: a thread is a lit line with a temperature,
 * not a swatch, and twenty saturated cords would read as a bag of colours
 * instead of one picture. `waiting` stays the highest: benign amber is the
 * state most easily confused with a green at a glance, and hue is the channel
 * that separates them. See docs/design-notes/palette-vibrancy-dials.md.
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
 * See docs/design-notes/palette-vibrancy-dials.md.
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
 * See docs/design-notes/palette-vibrancy-dials.md.
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
 * See docs/design-notes/palette-vibrancy-dials.md for why 1.6 and not a more
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
 * tissue is never ink. See docs/design-notes/palette-tissue-accent.md.
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

// ── the fruiting material (prd-33 amendment, loop 8): returned matter only ──

/**
 * THE SECOND ORGANIC MATERIAL — spore-print magenta, worn ONLY by matter that
 * has RETURNED (the landed remnant: persist strand and glyphs, the persisted
 * seal, the heart's growth rings, a landing's homecoming motes). Never a
 * status: as a status hue this arc is arithmetically impossible (the accent's
 * 60° law ∩ broken's 30° leave 43.9°–235.5°), and the amendment's whole claim
 * is that landed matter is MATERIAL, not vocabulary — law 9a intact because
 * this never joins it. The ledger's LANDED chip stays done-green for the same
 * reason, deliberately.
 *
 * Measured (theme/oklch.ts): H ≈ 335–341 in both worlds; ≥ 33° from broken,
 * ≥ 39° from the tissue accent (dark) / ≥ 42° (paper); the paper steps sit
 * ≥ 24 rgb-units clear of every paper register step so the fence below cannot
 * mistake structure ink for fruit. Ground-ward first, like the tissue ramp.
 */
export const FRUIT_RAMP: readonly Rgb[] = [
  [126, 74, 114], // FRUIT_700 — the deep step the persist recipe warms toward
  [178, 107, 163], // FRUIT_400 — the accent: the seal, the rings
  [214, 154, 196], // FRUIT_200 — the light end a homecoming mote cools to
]

const PAPER_FRUIT: readonly Rgb[] = [
  [109, 43, 88], // deep ink on paper
  [150, 64, 124], // the accent
  [192, 139, 176], // the faded end
]

/** Sample the fruiting ramp, 0 = deepest, 1 = lightest — tissueAtOn's twin. */
export function fruitAtOn(palette: ScenePalette, t: number): Rgb {
  const ramp = palette.fruit
  const last = ramp.length - 1
  const on = clamp01(t) * last
  const i = Math.min(last - 1, Math.floor(on))
  return mix(ramp[i] as Rgb, ramp[i + 1] as Rgb, on - i)
}

/** Sample the tissue ramp, 0 = its deepest step and 1 = its lightest. */
export function tissueAt(t: number): Rgb {
  const last = TISSUE_RAMP.length - 1
  const on = clamp01(t) * last
  const i = Math.min(last - 1, Math.floor(on))
  return mix(TISSUE_RAMP[i] as Rgb, TISSUE_RAMP[i + 1] as Rgb, on - i)
}

/**
 * {@link tissueAt}, generalised over a palette — byte-identical to it on dark
 * (`DARK_PALETTE.tissue === TISSUE_RAMP` by construction; sworn in
 * `palette.test.ts`). Both ramps are declared ground-ward first, so 0 is the
 * step nearest each world's own ground.
 */
export function tissueAtOn(palette: ScenePalette, t: number): Rgb {
  const ramp = palette.tissue
  const last = ramp.length - 1
  const on = clamp01(t) * last
  const i = Math.min(last - 1, Math.floor(on))
  return mix(ramp[i] as Rgb, ramp[i + 1] as Rgb, on - i)
}

/**
 * A returning mote's colour at `t` of its journey home (ruling 12): born in the
 * lane's own done-family colour, cooling through the tissue ramp as it travels.
 * The only place a status hue and the accent are allowed to touch. Entered from
 * the ramp's light end and travelled downward — a mote must arrive at the heart
 * as one of the ramp's own dark depths, not a bright violet dot laid on top of
 * them. See docs/design-notes/palette-tissue-accent.md.
 */
export function returningInk(family: Rgb, journey: number, luminance: number): Ink {
  const t = clamp01(journey)
  // The hand-off is early and soft: a mote is unmistakably its lane's colour for
  // the first third, and unmistakably tissue by the last.
  const cooled = mix(family, tissueAt(1 - t), Math.min(1, t * 1.4))
  return ink(cooled, clamp01(luminance))
}

/**
 * {@link returningInk}, generalised over the destination material (the
 * fruiting amendment): a LANDED lane's matter comes home to the fruit — the
 * spore-print the heart's ring will be laid in — while a dead lane's still
 * composts to tissue through `returningInk` exactly as ruling 12 wrote it.
 * Same envelope, same early-soft hand-off; only the home differs.
 */
export function returningInkToward(home: Rgb, family: Rgb, journey: number, luminance: number): Ink {
  const t = clamp01(journey)
  const cooled = mix(family, home, Math.min(1, t * 1.4))
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
 * {@link hotter}, generalised over a palette: heat is a march toward the
 * register's own peak, whichever world that peak is in. Byte-identical to
 * `hotter` on dark (`DARK_PALETTE.register.peak === ICE_050` — the identity is
 * sworn in `palette.test.ts`), and on paper "hotter" correctly means *deeper* —
 * more ink, not more light, because the page is already the brightest thing in
 * sight.
 */
export function hotterOn(palette: ScenePalette, rgb: Rgb, amount: number): Rgb {
  return mix(rgb, palette.register.peak, amount)
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

// ── PER-THEME TABLES (prd-32 rulings 4 and 7) ───────────────────────────────

/**
 * TWO WORLDS, AND THE ONE THING THAT DOES NOT SURVIVE THE CROSSING.
 *
 * Everything above this line is dark's, and dark remains the source of truth.
 * What follows is the machinery ruling 4 asks for — "`scene/palette.ts` becomes
 * per-theme tables" — plus the harder half of ruling 7, which is that severity
 * cannot come along unchanged.
 *
 * **The trap.** On the void, severity climbs by luminance: `CALM_CEILING` caps
 * the calm world at 0.78 and `ALARM_FLOOR` puts every summons above 0.84, so a
 * lane in trouble is literally the brightest thing on screen. Move that
 * encoding to warm paper and it inverts: brighter means *closer to the page*,
 * so a dying lane would recede exactly when it should not. The encoding is not
 * merely miscalibrated on paper — it means the opposite thing.
 *
 * **What is re-carried, and on what.** Severity travels here by **weight,
 * enclosure and saturation** ({@link SeverityReading}), and the band is
 * re-derived in **presence** ({@link presence}) — a mark's departure from its
 * own ground — rather than in luminance. On the void the two quantities very
 * nearly coincide, because the ground is nearly black and departing from black
 * *is* emitting light; that coincidence is the whole reason nobody had to name
 * the difference until a second ground existed.
 *
 * **What does not move.** `RECEDE`, `CALM_CEILING`, `ALARM_FLOOR` and
 * `CALM_FLOOR` are dark's numbers and stay exactly as they are (charter §2.2).
 * Light gets three of its own beside them — {@link PAPER_CALM_FLOOR},
 * {@link PAPER_CALM_CEILING}, {@link PAPER_ALARM_FLOOR} — derived against warm
 * paper rather than scaled off the void's. `RECEDE` is the one number the two
 * themes share, and the reason is worth stating: it is a *ratio*, so it is the
 * only part of the contrast budget that is not denominated in light at all.
 *
 * **What is still dark-only.** `marks/` and `salience.ts` are outside this
 * wave's fence and still paint from the constants above. The tables, the band
 * and the laws land here; the scene consuming {@link paletteFor} is the next
 * wave's work, and until it happens a light chrome sits over a void scene.
 */

/**
 * Which table. Deliberately declared here rather than imported from
 * `settings/`, and the direction is the point: the scene must not depend on the
 * settings surface to know what a palette is. It is the same two names
 * `settings/apply.ts` resolves an attribute to and the same two the registry
 * offers under `appearance.theme`, and `palette.test.ts` holds all three sets
 * equal — so a theme added to one of them and not the others fails rather than
 * quietly painting the void under a page that says it is light.
 */
export type ThemeName = 'dark' | 'light'

/**
 * The ten slots the two registers share.
 *
 * Named rather than numbered, because the numbers mean opposite things in the
 * two worlds: dark's ice ramp climbs as light is added and light's paper
 * register climbs as ink is. A slot is what the scene actually asks for — "the
 * ground", "body copy", "the peak" — and it survives the crossing where a
 * luminance step does not.
 */
export type RegisterSlot =
  | 'ground'
  | 'plate'
  | 'cold'
  | 'unknown'
  | 'oldest'
  | 'idle'
  | 'body'
  | 'data'
  | 'emphasis'
  | 'peak'

/** The six status hues (law 9a), by the name each one means. */
export interface StatusHues {
  readonly working: Rgb
  readonly done: Rgb
  readonly waitingBenign: Rgb
  readonly needsYou: Rgb
  readonly broken: Rgb
  readonly notice: Rgb
}

/**
 * How a rung reads, once brightness is taken off the table.
 *
 * The three carried channels are the ones ruling 7 names, and they are the ones
 * a reader can still use on a ground that is already at the top of the range.
 * `rgb`/`alpha` are the mark's actual ink; everything else is what the mark is
 * *made* of rather than what colour it is.
 */
export interface SeverityReading {
  /** The ink itself. */
  readonly rgb: Rgb
  /** How much of it. */
  readonly alpha: number
  /** Stroke weight, relative to a calm mark. Ruling 7's first carrier. */
  readonly weight: number
  /** Chroma gain over the resting tint. Ruling 7's third carrier. */
  readonly saturation: number
  /** 0 none · 0.5 a rule under the mark · 1 a full cartouche. The second. */
  readonly enclosure: number
}

/** The band a theme's severity is denominated in, and the units it is in. */
export interface SeverityBand {
  /** `luminance` on the void; `presence` on paper — the quantity, named. */
  readonly carrier: 'luminance' | 'presence'
  /** No living mark sits below this. */
  readonly floor: number
  /** No calm mark climbs above this. */
  readonly calmCeiling: number
  /** prd10 ruling 4's one door: a WORKING tip's own ceiling, between the calm ceiling and the alarm floor. */
  readonly tipCeiling: number
  /** Every alarm mark reaches this. */
  readonly alarmFloor: number
  /** What everything the spotlight is not on drops to. Shared — it is a ratio. */
  readonly recede: number
}

/** One theme's whole scene table. */
export interface ScenePalette {
  readonly theme: ThemeName
  /** The ground the network hangs in — the void, or the page. */
  readonly ground: Rgb
  /** The structural register, slot by slot. */
  readonly register: Readonly<Record<RegisterSlot, Rgb>>
  readonly status: StatusHues
  /** The one place a lane's activity becomes a colour, per theme. */
  readonly activity: Record<LaneActivity, Rgb>
  readonly necrotic: Rgb
  /** Five steps, ground-ward first — read as a gradient, never as five choices. */
  readonly tissue: readonly Rgb[]
  /** The fruiting material — returned matter only. See {@link FRUIT_RAMP}. */
  readonly fruit: readonly Rgb[]
  /** The alpha a living thread is drawn at with nothing going on at all. */
  readonly bodyFloor: number
  readonly band: SeverityBand
  /** The ladder, as four readings. See {@link SeverityReading}. */
  readonly severity: Readonly<Record<LadderRank, SeverityReading>>
}

// ── the void's table ────────────────────────────────────────────────────────

/**
 * Dark, assembled from the constants above rather than restated beside them —
 * so the table cannot drift from the register every mark in `marks/` still
 * imports directly.
 */
export const DARK_PALETTE: ScenePalette = {
  theme: 'dark',
  ground: ICE_1000,
  register: {
    ground: ICE_1000,
    plate: ICE_950,
    cold: ICE_700,
    unknown: ICE_600,
    oldest: ICE_500,
    idle: ICE_400,
    body: ICE_300,
    data: ICE_200,
    emphasis: ICE_100,
    peak: ICE_050,
  },
  status: {
    working: WORKING,
    done: DONE,
    waitingBenign: WAITING_BENIGN,
    needsYou: NEEDS_YOU,
    broken: BROKEN,
    notice: NOTICE,
  },
  activity: ACTIVITY_HUE,
  necrotic: NECROTIC,
  tissue: TISSUE_RAMP,
  fruit: FRUIT_RAMP,
  bodyFloor: CALM_BODY_FLOOR,
  band: {
    carrier: 'luminance',
    // The four immovable numbers plus ruling 4's tip door, restated by value
    // rather than by reference: `salience.ts` owns them and `palette.test.ts`
    // asserts they have not moved. They are written out here because
    // `salience.ts` imports this module, so the dependency cannot run the
    // other way.
    floor: 0.15,
    calmCeiling: 0.78,
    tipCeiling: 0.81,
    alarmFloor: 0.84,
    recede: 0.3,
  },
  /**
   * DARK'S LADDER, DESCRIBED HONESTLY — including the bit that is a luminance.
   *
   * Weight and saturation are flat all the way up, because on the void they do
   * not have to work: `marks/node.ts` adds an enclosure at the alarm rungs
   * (`node.ts:161`, alarm-only) and the brightness band does everything else.
   * That flatness is not an omission in this table, it is the finding — it is
   * what `palette.test.ts` measures when it flattens luminance and watches
   * dark's ladder stop climbing while light's keeps going.
   */
  severity: {
    calm: { ...activityInk('working', 0.5, 0), weight: 1, saturation: 1, enclosure: 0 },
    notice: { rgb: NOTICE, alpha: 1, weight: 1, saturation: 1, enclosure: 0 },
    'needs-you': { rgb: incandescent(NEEDS_YOU), alpha: 1, weight: 1, saturation: 1, enclosure: 1 },
    broken: { rgb: BROKEN, alpha: 1, weight: 1, saturation: 1, enclosure: 1 },
  },
}

// ── warm paper's table ──────────────────────────────────────────────────────

/**
 * THE PAPER REGISTER, mirrored for canvas exactly as the ice ramp is.
 *
 * Thirteen steps in `theme.css`, ten of them here — the same ten slots the ice
 * ramp lends the scene. Numbered by ink rather than by luminance: `000` is the
 * page with nothing on it, `950` is the deepest mark the instrument makes.
 */
const PAPER_000: Rgb = [252, 246, 235]
const PAPER_050: Rgb = [245, 238, 225]
const PAPER_300: Rgb = [169, 159, 163]
const PAPER_400: Rgb = [144, 128, 139]
const PAPER_500: Rgb = [124, 103, 119]
const PAPER_600: Rgb = [103, 76, 99]
const PAPER_700: Rgb = [83, 55, 79]
const PAPER_800: Rgb = [65, 38, 61]
const PAPER_900: Rgb = [49, 26, 46]
const PAPER_950: Rgb = [35, 15, 32]

/** The six, re-inked. Each keeps its dark counterpart's OKLCH hue angle. */
const PAPER_WORKING: Rgb = [0, 113, 55]
const PAPER_DONE: Rgb = [36, 127, 93]
const PAPER_WAITING_BENIGN: Rgb = [146, 106, 18]
const PAPER_NEEDS_YOU: Rgb = [120, 81, 0]
const PAPER_BROKEN: Rgb = [169, 0, 53]
const PAPER_NOTICE: Rgb = [0, 115, 134]

const PAPER_NECROTIC: Rgb = [173, 160, 170]

/** Ground-ward first, at the organism's own hue (295.5) in both worlds. */
const PAPER_TISSUE: readonly Rgb[] = [
  [237, 234, 249],
  [214, 207, 239],
  [185, 173, 223],
  [155, 138, 205],
  [134, 113, 189],
]

/**
 * THE LIGHT BAND — three numbers derived against paper, beside dark's four.
 *
 * Denominated in {@link presence}, which on paper runs the opposite way from
 * luminance: a mark departs from the page by *darkening*. So the same three
 * sentences hold — nothing living below the floor, nothing calm above the
 * ceiling, every alarm above the alarm floor — while the physical direction of
 * every one of them is reversed.
 *
 * They are chosen against this palette rather than scaled off dark's, because a
 * scaled band is an inverted palette wearing a different coat. The floor is
 * where the quietest activity ink actually lands (0.241 measured, so 0.20 has
 * room); the ceiling is what {@link capPresence} holds the calm world to; the
 * alarm floor is where {@link emphatic} puts a summons.
 */
export const PAPER_CALM_FLOOR = 0.2
/** @see PAPER_CALM_FLOOR */
export const PAPER_CALM_CEILING = 0.7
/** @see PAPER_CALM_FLOOR */
export const PAPER_ALARM_FLOOR = 0.75
/**
 * prd10 ruling 4's one door, in presence: a WORKING tip may sit a little above
 * the calm ceiling and stays well under the alarm floor. 0.72 mirrors dark's
 * spacing (0.78 / 0.81 / 0.84 — the tip closer to the calm ceiling than to the
 * alarm floor, deliberately: a little brighter than the fleet, nowhere near a
 * summons). OPERATOR ITEM (light-mode plan, 2c): the number is proposed and
 * pinned, and cheap to move before the light theme ships.
 */
export const PAPER_TIP_CEILING = 0.72

/**
 * The alpha a living thread is drawn at on paper with nothing going on — the
 * light counterpart of {@link CALM_BODY_FLOOR}, and a smaller number for a
 * reason that is not taste: alpha is *ink coverage* here, and a resting mark
 * that laid down 0.58 of the deepest plum in the register would read as heavier
 * than the body copy beside it.
 */
export const PAPER_BODY_FLOOR = 0.52

export const LIGHT_PALETTE: ScenePalette = {
  theme: 'light',
  ground: PAPER_000,
  register: {
    ground: PAPER_000,
    plate: PAPER_050,
    cold: PAPER_300,
    unknown: PAPER_400,
    oldest: PAPER_500,
    idle: PAPER_600,
    body: PAPER_700,
    data: PAPER_800,
    emphasis: PAPER_900,
    peak: PAPER_950,
  },
  status: {
    working: PAPER_WORKING,
    done: PAPER_DONE,
    waitingBenign: PAPER_WAITING_BENIGN,
    needsYou: PAPER_NEEDS_YOU,
    broken: PAPER_BROKEN,
    notice: PAPER_NOTICE,
  },
  activity: {
    working: PAPER_WORKING,
    waiting: PAPER_WAITING_BENIGN,
    done: PAPER_DONE,
    // Nothing to say is structure in both worlds — and `unknown` is still the
    // quieter of the two, which on paper means *less ink* where on the void it
    // meant less light. `palette.test.ts` asserts that in presence, which is
    // the one phrasing of the law that is true in both.
    idle: PAPER_600,
    unknown: PAPER_400,
  },
  necrotic: PAPER_NECROTIC,
  tissue: PAPER_TISSUE,
  fruit: PAPER_FRUIT,
  bodyFloor: PAPER_BODY_FLOOR,
  band: {
    carrier: 'presence',
    floor: PAPER_CALM_FLOOR,
    calmCeiling: PAPER_CALM_CEILING,
    tipCeiling: PAPER_TIP_CEILING,
    alarmFloor: PAPER_ALARM_FLOOR,
    // Shared with dark, and the only one that is: a ratio is not denominated in
    // light, so receding to three-tenths means the same thing on either ground.
    recede: 0.3,
  },
  /**
   * PAPER'S LADDER — the ruling's sentence, as four rows.
   *
   * "BROKEN gains a cartouche and weight where on the void it gained
   * luminance." Every step up climbs on all three carried channels, and the
   * enclosure arrives one rung earlier than it does on the void: on paper a
   * summons cannot buy its rung with brightness, so it buys half a cartouche —
   * a rule under the mark — where dark's summons simply got brighter.
   */
  severity: {
    calm: { rgb: PAPER_700, alpha: 0.62, weight: 1, saturation: 1, enclosure: 0 },
    notice: { rgb: PAPER_NOTICE, alpha: 0.8, weight: 1.3, saturation: 1.15, enclosure: 0 },
    'needs-you': {
      rgb: mix(PAPER_NEEDS_YOU, PAPER_950, 0.45),
      alpha: 1,
      weight: 1.8,
      saturation: 1.4,
      enclosure: 0.5,
    },
    broken: { rgb: PAPER_BROKEN, alpha: 1, weight: 2.4, saturation: 1.7, enclosure: 1 },
  },
}

/** Both tables, in the order `theme.css` declares them. */
export const PALETTES: Readonly<Record<ThemeName, ScenePalette>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
}

export function paletteFor(theme: ThemeName): ScenePalette {
  return PALETTES[theme]
}

// ── the arithmetic a second ground makes necessary ──────────────────────────

/**
 * PRESENCE — how far a mark departs from its own ground, alpha included.
 *
 * The quantity {@link luminance} has been standing in for since prd4. Composite
 * an ink of alpha *a* over a ground and the result's brightness is
 * `groundLum + a·(inkLum − groundLum)`, so the *departure* is `a·|inkLum −
 * groundLum|` — this function, exactly. On the void `groundLum` is 0.024 and
 * the two quantities agree to within that, which is why one number served for
 * two ideas for four PRDs. On paper `groundLum` is 0.966 and they run in
 * opposite directions.
 *
 * Note what this is not: {@link luminance} is still the budget dark's four
 * numbers are denominated in, and nothing here restates them.
 */
export function presence(value: Ink, ground: Rgb): number {
  return Math.abs(luminance(ink(value.rgb, 1)) - luminance(ink(ground, 1))) * clamp01(value.alpha)
}

/**
 * Scales alpha down — never up — until the ink departs from its ground by no
 * more than `ceiling`. The presence-denominated twin of `salience.ts`'s private
 * `capLuminance`, and deliberately written here rather than there: the four
 * numbers that file owns are dark's, and a light-mode cap living beside them
 * would be one edit away from renegotiating them.
 */
export function capPresence(source: Ink, ground: Rgb, ceiling: number): Ink {
  const here = presence(source, ground)
  if (here <= ceiling) return source
  return { rgb: source.rgb, alpha: clamp01(source.alpha * (ceiling / here)) }
}

/**
 * Scales alpha up — never down — until the ink departs from its ground by at
 * least `floor`, stopping at full opacity if even that cannot reach it.
 * {@link capPresence}'s opposite wall: the cap keeps the calm world inside its
 * ceiling; this holds a band-owing alarm mark to the band's own floor. Dark
 * never needs it — the void's alarm inks clear `ALARM_FLOOR` with luminance
 * headroom — but paper's emphatic amber touches its floor with almost none, so
 * a styling shave of alpha (an arm drawn at 0.98) would otherwise leave a
 * summons fractionally under the band it owes a mark to.
 */
export function floorPresence(source: Ink, ground: Rgb, floor: number): Ink {
  const here = presence(source, ground)
  if (here >= floor || here === 0) return source
  return { rgb: source.rgb, alpha: clamp01(source.alpha * (floor / here)) }
}

/**
 * The emphatic end of a family on paper — {@link incandescent}'s exact mirror.
 *
 * Dark's summons clears `ALARM_FLOOR` by being mixed toward the ice ramp's
 * white; paper's clears {@link PAPER_ALARM_FLOOR} by being mixed toward the
 * register's deepest ink. Same 0.45, same law, opposite direction, and both are
 * needed for the same reason: the raw family hue does not reach its own theme's
 * alarm floor on its own.
 */
export function emphatic(rgb: Rgb, palette: ScenePalette = LIGHT_PALETTE): Rgb {
  return mix(rgb, palette.register.peak, 0.45)
}

/**
 * A living lane's resting ink, in whichever world is on — {@link activityInk}
 * generalised over a palette, with dark's path byte-identical to the function it
 * generalises (`palette.test.ts` asserts that across the whole sweep, which is
 * what makes this a widening rather than a rewrite).
 *
 * The formula does not change and does not need to. `resting` walks the
 * register from its `oldest` slot to its `emphasis` slot as a lane freshens,
 * and alpha climbs from the theme's own body floor — both of which mean "more
 * of the register" in either world. What differs is only what the register's
 * ends *are*.
 */
export function activityInkOn(
  palette: ScenePalette,
  activity: LaneActivity,
  freshness: number,
  heat: number,
): Ink {
  const fresh = clamp01(freshness)
  const warm = clamp01(heat)
  const resting = mix(palette.register.oldest, palette.register.emphasis, fresh)
  const alpha = palette.bodyFloor + 0.3 * fresh + 0.2 * warm

  return ink(
    mix(resting, palette.activity[activity], ACTIVITY_TINT[activity]),
    activity === 'done' ? alpha * 0.85 : alpha,
  )
}

/**
 * Does severity climb from `lower` to `higher` on a channel a reader who cannot
 * use brightness still has?
 *
 * The whole of "severity is re-carried, not re-lit", as one predicate: at least
 * one of weight, enclosure and saturation must rise, and none of them may fall.
 * A step that falls on one channel while rising on another is not a ladder, it
 * is a trade.
 *
 * Deliberately not a score. A weighted sum of three channels would let a
 * reviewer tune the weights until any ladder passed, and would answer a
 * question nobody asked — "how much worse" — in place of the one ruling 7 does
 * ask, which is whether worse is legible at all.
 */
export function carriesSeverity(lower: SeverityReading, higher: SeverityReading): boolean {
  const channels: readonly (readonly [number, number])[] = [
    [lower.weight, higher.weight],
    [lower.enclosure, higher.enclosure],
    [lower.saturation, higher.saturation],
  ]
  return channels.some(([a, b]) => b > a) && channels.every(([a, b]) => b >= a)
}

/** The ladder, worst last — the order severity is read in. */
export const SEVERITY_LADDER: readonly LadderRank[] = ['calm', 'notice', 'needs-you', 'broken']
