import { classifyClaim } from './attribution.js'
import { summariseArm } from './summarise.js'
import type { Comparison, ComparisonInput } from './types.js'

/**
 * THE TOP-LEVEL COMBINATOR (prd14 ruling 3). Arm order is preserved from the
 * input straight through to the summary — there is no sort by value anywhere
 * in this module, because a sort is exactly how a "no winner" surface grows
 * a silent ranking.
 */
export function compareArms(input: ComparisonInput): Comparison {
  return {
    arms: input.arms.map(summariseArm),
    claim: classifyClaim(input.arms),
  }
}
