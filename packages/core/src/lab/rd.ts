/**
 * THE R&D HAND'S LAWS — prd55 ruling 3, beside {@link ./laws.ts}: the two pure
 * questions the schema in `events/lab.ts` and the engine (`server/src/lab/
 * rd.ts`, wave 5's second issue) both answer the same way, because they both
 * read them from here rather than restating them.
 *
 * - {@link isHeldBack} — may a PATTERN be proposed against at all? Gated by
 *   how many source items it groups. Below the floor a pattern is a single
 *   occurrence, not yet a pattern: "testing a shape that may not recur spends
 *   real money" (ruling 3's own words, quoted verbatim by the surface).
 * - {@link rdRefusalReason} — may a PROPOSAL be recorded as-is? Refused
 *   against a held-back pattern, or when its arms vary more than the one
 *   declared dimension. The reason returned is the exact sentence a surface
 *   prints — never templated per-call, so every refusal for the same cause
 *   reads identically (the same discipline laws.ts's `CONFOUND_VOICE` keeps).
 *
 * Pure and browser-safe (ADR-0003): no `node:*`, no I/O, no zod even — these
 * are counts, comparisons and fixed sentences. `rd.test.ts`'s grep law holds
 * this file to zero imports, the same way `laws.test.ts` holds `laws.ts`.
 */

/** A pattern needs at least this many source items to stop being a single occurrence (prd55 ruling 3). */
export const RD_PATTERN_FLOOR = 2

/** Whether a pattern with this many source items is held back — count < {@link RD_PATTERN_FLOOR}. */
export function isHeldBack(count: number): boolean {
  return Number.isInteger(count) && count < RD_PATTERN_FLOOR
}

/**
 * The four dimensions a proposal's arms may vary (prd55 ruling 3's closed
 * vocabulary). Not exported: `events/lab.ts`'s `rdVariesDimensionSchema`
 * infers the wire type of the same name, and re-exporting both through the
 * package barrel would be an ambiguous duplicate export. This module only
 * needs the shape, never the name.
 */
type RdVariesDimension = 'model' | 'brief' | 'checkpoint' | 'gate'

/**
 * What one arm carries on each of the four dimensions. `null` means the arm
 * inherits the default for that dimension — a value in its own right, not a
 * wildcard (the same reading {@link ./laws.ts}'s `LabTreatmentLike` gives
 * `model`/`promptDigest`).
 */
export interface RdArmTreatment {
  model: string | null
  brief: string | null
  checkpoint: string | null
  gate: string | null
}

/** Which of the four dimensions actually differ across a proposal's arms. Order-free; fewer than two arms varies nothing. */
export function rdDimensionsOf(arms: readonly RdArmTreatment[]): Record<RdVariesDimension, boolean> {
  const varies = (pick: (arm: RdArmTreatment) => string | null): boolean => new Set(arms.map(pick)).size > 1
  return {
    model: varies((arm) => arm.model),
    brief: varies((arm) => arm.brief),
    checkpoint: varies((arm) => arm.checkpoint),
    gate: varies((arm) => arm.gate),
  }
}

/** How many of the four dimensions vary. Exactly one is the only clean shape — zero is a replication, more than one a confound. */
export function rdDimensionsVariedCount(dimensions: Record<RdVariesDimension, boolean>): number {
  return (dimensions.model ? 1 : 0) + (dimensions.brief ? 1 : 0) + (dimensions.checkpoint ? 1 : 0) + (dimensions.gate ? 1 : 0)
}

/** The one sentence a surface prints for a proposal against a held-back pattern. */
export const RD_HELD_BACK_REFUSAL =
  'this pattern is held back — a single occurrence is not yet a pattern, and testing a shape that may not recur spends real money'

/** The one sentence a surface prints for a proposal whose arms vary more than one dimension. */
export const RD_MULTI_DIMENSION_REFUSAL = 'these arms differ in more than one dimension — a difference cannot be attributed to any of them'

/**
 * The one sentence a surface prints for a proposal whose arms vary exactly one
 * dimension, but not the one the proposal declares it varies. The COUNT being
 * one is not enough: ruling 3's arms differ "in that dimension only", and a
 * proposal that says `varies: 'model'` while its arms actually differ in the
 * gate would have its difference booked against the model — the same
 * misattribution {@link RD_MULTI_DIMENSION_REFUSAL} exists to prevent, one
 * size smaller and invisible to a count.
 */
export const RD_WRONG_DIMENSION_REFUSAL =
  'these arms differ in a dimension this proposal does not declare — the difference would be attributed to the wrong one'

/**
 * Whether every dimension that actually varies across these arms is the one
 * the proposal declares (ruling 3's "2-3 arms differing in that dimension
 * only"). Zero varying dimensions passes: that is a replication, which
 * {@link rdDimensionsVariedCount}'s own doc comment already treats as a
 * legitimate shape rather than a confound — this law rules only on a
 * difference that would be booked against the wrong dimension.
 */
export function rdVariesOnlyDeclaredDimension(declared: RdVariesDimension, arms: readonly RdArmTreatment[]): boolean {
  const dimensions = rdDimensionsOf(arms)
  return (Object.keys(dimensions) as RdVariesDimension[]).every((dimension) => !dimensions[dimension] || dimension === declared)
}

/**
 * The one function that decides whether a proposal is refused (prd55 ruling
 * 3): against a held-back pattern, with arms varying more than one dimension,
 * or with arms varying a dimension other than the one it declares. Returns
 * the sentence a surface prints verbatim, or `null` when
 * the proposal is clean. Held-back is checked first — a held-back pattern's
 * proposal is refused for that reason even when its arms would otherwise be
 * clean, so the reason a reader sees is always the more fundamental one. `varies` is
 * required, not optional: an optional dimension is a check that silently does
 * not run for whoever forgets to pass one, and the compiler asking every
 * caller for it is the whole guard.
 */
export function rdRefusalReason(input: { patternHeldBack: boolean; varies: RdVariesDimension; arms: readonly RdArmTreatment[] }): string | null {
  if (input.patternHeldBack) return RD_HELD_BACK_REFUSAL
  if (rdDimensionsVariedCount(rdDimensionsOf(input.arms)) > 1) return RD_MULTI_DIMENSION_REFUSAL
  if (!rdVariesOnlyDeclaredDimension(input.varies, input.arms)) return RD_WRONG_DIMENSION_REFUSAL
  return null
}
