export {
  type ComparisonArtifact,
  ComparisonArtifactError,
  parseComparisonArtifact,
  serialiseComparison,
} from './artifact.js'
export { classifyClaim, differingDimensions, formatDimensionList } from './attribution.js'
export { ComparisonSurface, type ComparisonSurfaceProps } from './ComparisonSurface.js'
export { compareArms } from './compare.js'
export { ExperimentComparison, type ExperimentComparisonProps } from './ExperimentComparison.js'
export {
  experimentToComparisonInput,
  MEASURE_BASIS,
  MEASURE_LABEL,
  MEASURES,
  type Measure,
  median,
  NOT_MEASURED,
  runForMeasure,
  SCORING_UNAVAILABLE,
} from './fromExperiment.js'
export { summariseArm } from './summarise.js'
export type {
  Arm,
  ArmSummary,
  Comparison,
  ComparisonClaim,
  ComparisonInput,
  Dimension,
  FailedArm,
  Run,
  Spread,
} from './types.js'
