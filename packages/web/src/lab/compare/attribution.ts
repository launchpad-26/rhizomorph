import type { Arm, ComparisonClaim, Dimension } from './types.js'

/**
 * ATTRIBUTION HONESTY (prd14 ruling 2). Which dimensions differ between arms
 * is computed from the arms' own `model`/`brief` fields — never from a
 * declared intent, because an intent can be wrong and the configuration
 * cannot.
 */
export function differingDimensions(arms: Arm[]): Dimension[] {
  const dims: Dimension[] = []
  if (new Set(arms.map((arm) => arm.model)).size > 1) dims.push('model')
  if (new Set(arms.map((arm) => arm.brief)).size > 1) dims.push('brief')
  return dims
}

/** `['model']` → `"model"`, `['model', 'brief']` → `"model and brief"`. */
export function formatDimensionList(dims: Dimension[]): string {
  if (dims.length === 0) return ''
  if (dims.length === 1) return dims[0]!
  if (dims.length === 2) return `${dims[0]!} and ${dims[1]!}`
  return `${dims.slice(0, -1).join(', ')}, and ${dims[dims.length - 1]!}`
}

/**
 * Exactly one differing dimension → compared properly (ruling 3's full
 * treatment). More than one → **no comparative claim**, an explicit voice
 * naming why, in the ruling's own words.
 */
export function classifyClaim(arms: Arm[]): ComparisonClaim {
  if (arms.length < 2) return { kind: 'single-arm' }

  const dims = differingDimensions(arms)
  if (dims.length === 0) return { kind: 'uniform' }
  if (dims.length === 1) return { kind: 'comparable', dimension: dims[0]! }

  return {
    kind: 'confounded',
    dimensions: dims,
    reason: `these arms differ in ${formatDimensionList(dims)}, so a difference cannot be attributed to either.`,
  }
}
