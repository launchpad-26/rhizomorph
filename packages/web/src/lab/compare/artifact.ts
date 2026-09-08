import type { Arm, ComparisonInput, Run } from './types.js'

/**
 * A FINISHED COMPARISON, SAVED AS A REOPENABLE ARTIFACT (prd14 ruling 3, law
 * 6). A pure serialise/parse pair over this subtree's own plain input — not
 * wired to prd16's recording machinery yet, so a later wave can adopt that
 * machinery around this shape without reworking the comparison logic itself.
 *
 * Parsing is defensive rather than a bare cast: a `JSON.parse` of arbitrary
 * text is `unknown`, and this is the boundary an old or hand-edited artifact
 * would need lenient handling at — real validation now, so a real chokepoint
 * exists to make lenient later (the prd17 shape) rather than a `as` that
 * silently accepts garbage today.
 *
 * The run shape follows `types.ts`: since prd53 ruling 2's amendment a
 * completed run carries its verdict and a value that may be null, and the
 * old `failed` run status is RETIRED — a failed gate is a completed run. No
 * production artifact was ever written in the old shape (this pair has no
 * production caller yet — prd-14 ruling 5's #213 wires it), so the retired
 * status is refused by name rather than silently reinterpreted.
 */
export interface ComparisonArtifact {
  version: 1
  savedAt: string
  input: ComparisonInput
}

export class ComparisonArtifactError extends Error {}

export function serialiseComparison(input: ComparisonInput, savedAt: string): string {
  const artifact: ComparisonArtifact = { version: 1, savedAt, input }
  return `${JSON.stringify(artifact, null, 2)}\n`
}

export function parseComparisonArtifact(raw: string): ComparisonArtifact {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new ComparisonArtifactError('comparison artifact is not valid JSON')
  }

  if (!isRecord(data)) {
    throw new ComparisonArtifactError('comparison artifact is not a JSON object')
  }
  if (data.version !== 1) {
    throw new ComparisonArtifactError(`unsupported comparison artifact version: ${String(data.version)}`)
  }
  if (typeof data.savedAt !== 'string') {
    throw new ComparisonArtifactError('comparison artifact is missing savedAt')
  }

  return { version: 1, savedAt: data.savedAt, input: parseComparisonInput(data.input) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseComparisonInput(value: unknown): ComparisonInput {
  if (!isRecord(value) || !Array.isArray(value.arms)) {
    throw new ComparisonArtifactError('comparison artifact is missing its arms array')
  }
  return { arms: value.arms.map(parseArm) }
}

function parseArm(value: unknown): Arm {
  if (!isRecord(value)) throw new ComparisonArtifactError('arm is not a JSON object')
  const { id, model, brief, runs } = value
  if (typeof id !== 'string' || typeof model !== 'string' || typeof brief !== 'string' || !Array.isArray(runs)) {
    throw new ComparisonArtifactError('arm is missing one of id, model, brief, runs')
  }
  return { id, model, brief, runs: runs.map(parseRun) }
}

function parseRun(record: unknown): Run {
  if (!isRecord(record)) throw new ComparisonArtifactError('run is not a JSON object')
  const { id, status } = record
  if (typeof id !== 'string') throw new ComparisonArtifactError('run is missing id')

  if (status === 'complete') {
    const { verdict, value } = record
    if (verdict !== 'pass' && verdict !== 'fail') throw new ComparisonArtifactError(`complete run ${id} is missing its verdict (pass or fail)`)
    if (typeof value !== 'number' && value !== null) throw new ComparisonArtifactError(`complete run ${id} has a value that is neither a number nor null`)
    return {
      id,
      status: 'complete',
      verdict,
      value,
      ...(typeof record.note === 'string' ? { note: record.note } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    }
  }
  if (status === 'pending') return typeof record.note === 'string' ? { id, status: 'pending', note: record.note } : { id, status: 'pending' }
  if (status === 'failed') {
    throw new ComparisonArtifactError(
      `run ${id} carries the retired status "failed" — since prd53 ruling 2's amendment a failed gate is a completed run with verdict "fail"`,
    )
  }
  throw new ComparisonArtifactError(`run ${id} has an unknown status: ${String(status)}`)
}
