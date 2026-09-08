import { useState } from 'react'
import type { LabExperiment } from '../types.js'
import { ComparisonSurface } from './ComparisonSurface.js'
import { compareArms } from './compare.js'
import { experimentToComparisonInput, type Measure } from './fromExperiment.js'
import type { FailedArm } from './types.js'

/**
 * One experiment, compared: owns the measure the runs are read for, and
 * nothing else. Every switch re-reads the experiment's runs through
 * `experimentToComparisonInput` and re-summarises through `compareArms`, so a
 * spread is always a spread OF the current measure — never a cached number.
 */
export interface ExperimentComparisonProps {
  experiment: LabExperiment
  /** Arms the launch asked for that never dispatched — known only to the launch that saw it (prd53 ruling 7). */
  failedArms?: readonly FailedArm[]
  initialMeasure?: Measure
}

export function ExperimentComparison({ experiment, failedArms = [], initialMeasure = 'cost' }: ExperimentComparisonProps) {
  const [measure, setMeasure] = useState<Measure>(initialMeasure)
  const comparison = compareArms(experimentToComparisonInput(experiment, measure))
  return <ComparisonSurface comparison={comparison} measure={measure} onMeasureChange={setMeasure} failedArms={failedArms} />
}
