export { differingDimensions, formatDimensionList, classifyClaim } from './attribution.js'
export { summariseArm } from './summarise.js'
export { compareArms } from './compare.js'
export {
  serialiseComparison,
  parseComparisonArtifact,
  ComparisonArtifactError,
  type ComparisonArtifact,
} from './artifact.js'
export { ComparisonSurface, type ComparisonSurfaceProps } from './ComparisonSurface.js'
export type {
  Arm,
  ArmSummary,
  Comparison,
  ComparisonClaim,
  ComparisonInput,
  Dimension,
  Run,
  Spread,
} from './types.js'
