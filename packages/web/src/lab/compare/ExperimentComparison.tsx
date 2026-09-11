import { useState } from 'react'
import type { LabExperiment } from '../types.js'
import { ComparisonSurface } from './ComparisonSurface.js'
import { compareArms } from './compare.js'
import { experimentToComparisonInput, type Measure } from './fromExperiment.js'
import { SaveComparisonControl } from './SaveComparisonControl.js'
import type { FailedArm } from './types.js'

/**
 * One experiment, compared: owns the measure the runs are read for, and
 * nothing else. Every switch re-reads the experiment's runs through
 * `experimentToComparisonInput` and re-summarises through `compareArms`, so a
 * spread is always a spread OF the current measure — never a cached number.
 *
 * Carries the save control (prd-14 ruling 5, #214) — this is "the comparison
 * surface itself" the issue's Definition of done names, the one place a
 * human sees this comparison and can keep it. What is saved is the CURRENT
 * measure's input, since an artifact records no measure of its own
 * (`compare/types.ts`'s `Run` carries only its resolved `value`, not which
 * measure produced it); reopening it from the recordings library therefore
 * states the basis as not recorded and shows no numeric summary at all
 * (`ComparisonSurface`'s `measure={null}` path) — every run's own verdict
 * still renders, but never a spread or a count computed over a unit the
 * reopen cannot name (review round 3: a `verified`-saved comparison's `1`/`0`
 * encoding is not a quantity, and summarising it as one is a confident wrong
 * statistic, not merely a wrong label).
 */
export interface ExperimentComparisonProps {
  experiment: LabExperiment
  /** Arms the launch asked for that never dispatched — known only to the launch that saw it (prd53 ruling 7). */
  failedArms?: readonly FailedArm[]
  initialMeasure?: Measure
}

export function ExperimentComparison({ experiment, failedArms = [], initialMeasure = 'cost' }: ExperimentComparisonProps) {
  const [measure, setMeasure] = useState<Measure>(initialMeasure)
  const input = experimentToComparisonInput(experiment, measure)
  const comparison = compareArms(input)
  return (
    <div className="flex flex-col gap-3">
      <ComparisonSurface comparison={comparison} measure={measure} onMeasureChange={setMeasure} failedArms={failedArms} />
      <SaveComparisonControl input={input} />
    </div>
  )
}
